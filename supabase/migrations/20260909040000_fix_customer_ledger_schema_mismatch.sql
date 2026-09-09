-- MIZAN: production-schema compatibility fix for customer_ledger.
-- Verified defect: public.customer_ledger has posted_at but no created_at.
-- The financial functions below were still inserting customer_ledger.created_at,
-- which breaks bill/collection posting with SQLSTATE 42703.
-- This migration changes only the function writers; it does not alter historical rows.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_post_bill_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _debit NUMERIC(18,3);
  _display_arrears NUMERIC(18,3);
BEGIN
  IF COALESCE(NEW.status, 'unpaid') = 'void' OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Arrears are an invoice snapshot only. They must not be debited again.
  _display_arrears := GREATEST(
    COALESCE(NEW.arrears_snapshot, 0),
    COALESCE(NEW.arrears, 0)
  );

  _debit := ROUND(
    COALESCE(
      NULLIF(NEW.net_amount, 0),
      NULLIF(NEW.subtotal, 0),
      NULLIF(NEW.amount, 0),
      NULLIF(GREATEST(COALESCE(NEW.total, 0) - _display_arrears, 0), 0),
      0
    ),
    3
  );

  IF _debit > 0 THEN
    PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

    INSERT INTO public.customer_ledger (
      tenant_id,
      customer_id,
      entry_type,
      reference_id,
      debit_amount,
      credit_amount,
      running_balance,
      description,
      posted_at
    )
    VALUES (
      NEW.tenant_id,
      NEW.customer_id,
      'bill',
      NEW.id,
      _debit,
      0,
      0,
      FORMAT('إصدار رسوم دورة حالية بمبلغ %s', _debit),
      COALESCE(NEW.issued_at, NEW.created_at, NOW())
    )
    ON CONFLICT (tenant_id, reference_id, entry_type) DO NOTHING;

    PERFORM public.recalc_customer_balance(NEW.customer_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_bill_to_ledger ON public.water_bills;
CREATE TRIGGER trg_post_bill_to_ledger
AFTER INSERT ON public.water_bills
FOR EACH ROW
EXECUTE FUNCTION public.tg_post_bill_to_ledger();

CREATE OR REPLACE FUNCTION public.approve_payment(_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _uid UUID := auth.uid();
  _pay public.payments%ROWTYPE;
  _bill public.water_bills%ROWTYPE;
  _approved NUMERIC(18,3);
  _new_paid NUMERIC(18,3);
  _new_status TEXT;
BEGIN
  PERFORM public.assert_authenticated_context();
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO _pay
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment not found'; END IF;

  IF _pay.status = 'approved' THEN
    PERFORM public.recalc_customer_balance(_pay.customer_id);
    RETURN;
  END IF;
  IF _pay.status <> 'pending' THEN
    RAISE EXCEPTION 'only pending payments can be approved';
  END IF;

  IF NOT (
    public.has_tenant_role(_pay.tenant_id,'manager')
    OR public.has_tenant_role(_pay.tenant_id,'admin')
    OR public.has_tenant_role(_pay.tenant_id,'accountant')
    OR public.has_tenant_role(_pay.tenant_id,'super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO _bill
  FROM public.water_bills
  WHERE id = _pay.bill_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found'; END IF;

  PERFORM public.acquire_customer_lock(_pay.tenant_id, _pay.customer_id);

  SELECT COALESCE(SUM(amount),0)
  INTO _approved
  FROM public.payments
  WHERE bill_id = _bill.id
    AND status = 'approved'
    AND id <> _pay.id;

  _new_paid := ROUND(_approved + _pay.amount, 3);
  IF _new_paid > ROUND(COALESCE(_bill.total,0),3) + 0.0005 THEN
    RAISE EXCEPTION 'approval would exceed bill total';
  END IF;

  _new_status := CASE
    WHEN _new_paid >= ROUND(COALESCE(_bill.total,0),3) - 0.0005 THEN 'paid'
    WHEN _new_paid > 0 THEN 'partial'
    ELSE 'unpaid'
  END;

  UPDATE public.payments
  SET status = 'approved', approved_at = NOW(), approved_by = _uid, updated_at = NOW()
  WHERE id = _pay.id;

  INSERT INTO public.customer_ledger (
    tenant_id,
    customer_id,
    entry_type,
    reference_id,
    debit_amount,
    credit_amount,
    running_balance,
    description,
    posted_at
  )
  VALUES (
    _pay.tenant_id,
    _pay.customer_id,
    'payment',
    _pay.id,
    0,
    ROUND(_pay.amount,3),
    0,
    FORMAT('اعتماد سداد فاتورة بمبلغ %s', ROUND(_pay.amount,3)),
    NOW()
  )
  ON CONFLICT (tenant_id, reference_id, entry_type) DO NOTHING;

  UPDATE public.water_bills
  SET
    paid_amount = _new_paid,
    status = _new_status,
    paid_at = CASE WHEN _new_status = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
    updated_at = NOW()
  WHERE id = _bill.id;

  PERFORM public.recalc_customer_balance(_pay.customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_payment(UUID) TO authenticated;

COMMIT;
