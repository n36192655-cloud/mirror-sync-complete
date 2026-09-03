-- MIZAN AI — Production payment lifecycle integrity
-- This migration extracts only the missing safety invariants from the superseded
-- financial PR. It does not merge or restore the legacy payment implementation.
--
-- Invariants:
--   1) financial posting is forbidden in closed accounting periods;
--   2) approve_payment_transaction is only a compatibility alias to the
--      canonical approve_payment path;
--   3) water_bills.paid_amount can never exceed water_bills.total;
--   4) existing production payment/ledger semantics remain authoritative.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.is_period_closed(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Production integrity prerequisite missing: public.is_period_closed(uuid,date)';
  END IF;
END;
$$;

-- Fail closed if historical data already violates the invariant. Do not add a
-- constraint that would merely expose an unresolved production data problem.
DO $$
DECLARE
  _violations BIGINT;
BEGIN
  SELECT COUNT(*) INTO _violations
  FROM public.water_bills
  WHERE paid_amount IS NOT NULL
    AND paid_amount < 0;

  IF _violations > 0 THEN
    RAISE EXCEPTION 'Cannot deploy: % water_bills rows have negative paid_amount', _violations;
  END IF;

  SELECT COUNT(*) INTO _violations
  FROM public.water_bills
  WHERE paid_amount IS NOT NULL
    AND paid_amount > COALESCE(total, 0) + 0.0001;

  IF _violations > 0 THEN
    RAISE EXCEPTION 'Cannot deploy: % water_bills rows have paid_amount above total', _violations;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'water_bills_paid_amount_range'
      AND conrelid = 'public.water_bills'::regclass
  ) THEN
    ALTER TABLE public.water_bills
      ADD CONSTRAINT water_bills_paid_amount_range
      CHECK (
        paid_amount IS NULL
        OR (paid_amount >= 0 AND paid_amount <= COALESCE(total, 0) + 0.0001)
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_payment(
  _bill_id UUID,
  _amount NUMERIC,
  _method TEXT,
  _client_uuid TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _uid UUID := auth.uid();
  _bill public.water_bills%ROWTYPE;
  _approved NUMERIC(18,3);
  _pending NUMERIC(18,3);
  _remaining NUMERIC(18,3);
  _existing UUID;
  _new_id UUID;
BEGIN
  PERFORM public.assert_authenticated_context();

  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;

  SELECT * INTO _bill
  FROM public.water_bills
  WHERE id = _bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill not found';
  END IF;
  IF _bill.status IN ('paid','void') THEN
    RAISE EXCEPTION 'bill is not payable';
  END IF;
  IF public.is_period_closed(_bill.tenant_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'cannot create a financial payment in a closed accounting period';
  END IF;
  IF NOT (
    public.has_tenant_role(_bill.tenant_id,'collector')
    OR public.has_tenant_role(_bill.tenant_id,'manager')
    OR public.has_tenant_role(_bill.tenant_id,'admin')
    OR public.has_tenant_role(_bill.tenant_id,'accountant')
    OR public.has_tenant_role(_bill.tenant_id,'super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF _client_uuid IS NOT NULL THEN
    SELECT id INTO _existing
    FROM public.payments
    WHERE tenant_id = _bill.tenant_id
      AND client_uuid = _client_uuid
    LIMIT 1;
    IF _existing IS NOT NULL THEN
      RETURN _existing;
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount),0)::NUMERIC(18,3)
    INTO _approved
  FROM public.payments
  WHERE bill_id = _bill.id AND status = 'approved';

  SELECT COALESCE(SUM(amount),0)::NUMERIC(18,3)
    INTO _pending
  FROM public.payments
  WHERE bill_id = _bill.id AND status = 'pending';

  _remaining := ROUND(COALESCE(_bill.total,0) - _approved - _pending, 3);

  IF _remaining <= 0 THEN
    RAISE EXCEPTION 'bill has no remaining balance';
  END IF;
  IF _amount > _remaining + 0.0005 THEN
    RAISE EXCEPTION 'amount exceeds remaining balance';
  END IF;

  INSERT INTO public.payments (
    tenant_id,bill_id,customer_id,amount,method,client_uuid,status,
    collected_by,payment_date,created_at,updated_at
  ) VALUES (
    _bill.tenant_id,_bill.id,_bill.customer_id,ROUND(_amount,3),
    COALESCE(NULLIF(_method,''),'cash'),_client_uuid,'pending',
    _uid,NOW(),NOW(),NOW()
  )
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;

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
  _approved_before NUMERIC(18,3);
  _new_paid NUMERIC(18,3);
  _new_status TEXT;
  _period_date DATE;
BEGIN
  PERFORM public.assert_authenticated_context();

  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO _pay
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment not found';
  END IF;
  IF _pay.status <> 'pending' THEN
    RAISE EXCEPTION 'only pending payments can be approved';
  END IF;
  IF _pay.bill_id IS NULL THEN
    RAISE EXCEPTION 'payment has no bill';
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

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill not found';
  END IF;

  _period_date := COALESCE(_pay.payment_date::date, _bill.issued_at::date, CURRENT_DATE);
  IF public.is_period_closed(_pay.tenant_id, _period_date) THEN
    RAISE EXCEPTION 'cannot post payment into a closed accounting period';
  END IF;

  PERFORM public.acquire_customer_lock(_pay.tenant_id,_pay.customer_id);

  SELECT COALESCE(SUM(amount),0)::NUMERIC(18,3)
    INTO _approved_before
  FROM public.payments
  WHERE bill_id = _bill.id
    AND status = 'approved'
    AND id <> _pay.id;

  _new_paid := ROUND(_approved_before + _pay.amount,3);

  IF _new_paid > ROUND(COALESCE(_bill.total,0),3) + 0.0005 THEN
    RAISE EXCEPTION 'approval would exceed bill total; payment remains pending';
  END IF;

  IF _new_paid >= ROUND(COALESCE(_bill.total,0),3) - 0.0005 THEN
    _new_paid := ROUND(COALESCE(_bill.total,0),3);
    _new_status := 'paid';
  ELSIF _new_paid > 0 THEN
    _new_status := 'partial';
  ELSE
    _new_status := 'unpaid';
  END IF;

  UPDATE public.payments
  SET status='approved', approved_at=NOW(), approved_by=_uid, updated_at=NOW()
  WHERE id=_pay.id;

  INSERT INTO public.customer_ledger (
    tenant_id,customer_id,entry_type,reference_id,debit_amount,credit_amount,
    running_balance,description,posted_at,created_at
  ) VALUES (
    _pay.tenant_id,_pay.customer_id,'payment',_pay.id,0,ROUND(_pay.amount,3),0,
    FORMAT('اعتماد سداد فاتورة بمبلغ %s',ROUND(_pay.amount,3)),NOW(),NOW()
  )
  ON CONFLICT (tenant_id,reference_id,entry_type) DO NOTHING;

  UPDATE public.water_bills
  SET paid_amount=_new_paid,
      status=_new_status,
      paid_at=CASE WHEN _new_status='paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END,
      updated_at=NOW()
  WHERE id=_bill.id;

  PERFORM public.recalc_customer_balance(_pay.customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_payment(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_payment_transaction(_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.approve_payment(_payment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment_transaction(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_payment_transaction(UUID) TO authenticated;

COMMIT;
