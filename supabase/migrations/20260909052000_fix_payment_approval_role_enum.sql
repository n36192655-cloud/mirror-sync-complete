BEGIN;

-- The production app_role enum is authoritative: super_admin, manager,
-- reader, collector. Do not reference nonexistent enum values such as admin
-- or accountant in financial authorization checks.
CREATE OR REPLACE FUNCTION public.approve_payment(_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
DECLARE
  _uid UUID := auth.uid();
  _pay public.payments%ROWTYPE;
  _bill public.water_bills%ROWTYPE;
  _approved NUMERIC(18,3);
  _new_paid NUMERIC(18,3);
  _new_status TEXT;
  _current NUMERIC(18,3);
BEGIN
  PERFORM public.assert_authenticated_context();
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO _pay FROM public.payments WHERE id=_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment not found'; END IF;
  IF _pay.status='approved' THEN
    PERFORM public.recalc_customer_balance(_pay.customer_id);
    RETURN;
  END IF;
  IF _pay.status<>'pending' THEN RAISE EXCEPTION 'only pending payments can be approved'; END IF;

  -- Only roles that actually exist in public.app_role are referenced.
  IF NOT (
    public.has_tenant_role(_pay.tenant_id,'manager'::public.app_role)
    OR public.has_tenant_role(_pay.tenant_id,'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO _bill FROM public.water_bills WHERE id=_pay.bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found'; END IF;

  PERFORM public.acquire_customer_lock(_pay.tenant_id,_pay.customer_id);

  SELECT COALESCE(SUM(amount),0)
  INTO _approved
  FROM public.payments
  WHERE bill_id=_bill.id AND status='approved' AND id<>_pay.id;

  _new_paid:=ROUND(_approved+_pay.amount,3);
  IF _new_paid>ROUND(COALESCE(_bill.total,0),3)+0.0005 THEN
    RAISE EXCEPTION 'approval would exceed bill total';
  END IF;

  _new_status:=CASE
    WHEN _new_paid>=ROUND(COALESCE(_bill.total,0),3)-0.0005 THEN 'paid'
    WHEN _new_paid>0 THEN 'partial'
    ELSE 'unpaid'
  END;

  UPDATE public.payments
  SET status='approved', approved_at=NOW(), approved_by=_uid, updated_at=NOW()
  WHERE id=_pay.id;

  SELECT COALESCE(current_balance,0)
  INTO _current
  FROM public.customer_balances
  WHERE tenant_id=_pay.tenant_id AND customer_id=_pay.customer_id
  FOR UPDATE;

  INSERT INTO public.customer_ledger(
    tenant_id,customer_id,entry_type,reference_id,
    debit_amount,credit_amount,running_balance,description,posted_at
  )
  VALUES(
    _pay.tenant_id,_pay.customer_id,'payment',_pay.id,0,
    ROUND(_pay.amount,3),
    COALESCE(_current,0)-ROUND(_pay.amount,3),
    FORMAT('اعتماد سداد فاتورة بمبلغ %s',ROUND(_pay.amount,3)),NOW()
  )
  ON CONFLICT(tenant_id,reference_id,entry_type) DO NOTHING;

  UPDATE public.water_bills
  SET paid_amount=_new_paid,
      status=_new_status,
      paid_at=CASE WHEN _new_status='paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END,
      updated_at=NOW()
  WHERE id=_bill.id;

  PERFORM public.recalc_customer_balance(_pay.customer_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.approve_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_payment(uuid) TO authenticated;

COMMIT;
