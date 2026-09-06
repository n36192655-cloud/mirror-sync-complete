-- MIZAN AI - Critical Production Financial Consistency Fix
-- Scope: payment lifecycle, bill status, customer ledger and balance consistency.
-- This migration intentionally preserves the original payment amount in the ledger;
-- it never caps an accounting entry to the bill total.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Canonical payment submission
-- ---------------------------------------------------------------------------
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

  IF public.is_period_closed(_bill.tenant_id, COALESCE(_bill.issued_at::date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'cannot create a financial payment against a closed accounting period';
  END IF;

  IF NOT (
    public.has_tenant_role(_bill.tenant_id, 'collector')
    OR public.has_tenant_role(_bill.tenant_id, 'manager')
    OR public.has_tenant_role(_bill.tenant_id, 'admin')
    OR public.has_tenant_role(_bill.tenant_id, 'accountant')
    OR public.has_tenant_role(_bill.tenant_id, 'super_admin')
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

  SELECT COALESCE(SUM(amount), 0)::NUMERIC(18,3)
  INTO _approved
  FROM public.payments
  WHERE bill_id = _bill.id
    AND status = 'approved';

  SELECT COALESCE(SUM(amount), 0)::NUMERIC(18,3)
  INTO _pending
  FROM public.payments
  WHERE bill_id = _bill.id
    AND status = 'pending';

  _remaining := ROUND(COALESCE(_bill.total, 0) - _approved - _pending, 3);

  IF _remaining <= 0 THEN
    RAISE EXCEPTION 'bill has no remaining amount to collect';
  END IF;
  IF _amount > _remaining + 0.0001 THEN
    RAISE EXCEPTION 'amount exceeds remaining balance (%.3f)', _remaining;
  END IF;

  INSERT INTO public.payments (
    tenant_id,
    bill_id,
    customer_id,
    amount,
    method,
    client_uuid,
    status,
    created_by,
    payment_date,
    created_at,
    updated_at
  ) VALUES (
    _bill.tenant_id,
    _bill.id,
    _bill.customer_id,
    ROUND(_amount, 3),
    COALESCE(NULLIF(_method, ''), 'cash'),
    _client_uuid,
    'pending',
    _uid,
    NOW(),
    NOW(),
    NOW()
  )
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(UUID, NUMERIC, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Canonical atomic approval
-- ---------------------------------------------------------------------------
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
    RAISE EXCEPTION 'payment is not pending';
  END IF;
  IF _pay.bill_id IS NULL THEN
    RAISE EXCEPTION 'payment has no bill';
  END IF;

  IF NOT (
    public.has_tenant_role(_pay.tenant_id, 'manager')
    OR public.has_tenant_role(_pay.tenant_id, 'admin')
    OR public.has_tenant_role(_pay.tenant_id, 'accountant')
    OR public.has_tenant_role(_pay.tenant_id, 'super_admin')
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

  -- The bill row is locked before recalculating approved payments. This makes
  -- concurrent approvals serialize on the same bill.
  SELECT COALESCE(SUM(amount), 0)::NUMERIC(18,3)
  INTO _approved_before
  FROM public.payments
  WHERE bill_id = _bill.id
    AND status = 'approved'
    AND id <> _pay.id;

  _new_paid := ROUND(_approved_before + _pay.amount, 3);

  -- Never write a capped bill amount while recording the full payment in the
  -- ledger. Either the whole payment is valid, or the transaction aborts.
  IF _new_paid > ROUND(COALESCE(_bill.total, 0), 3) + 0.0001 THEN
    RAISE EXCEPTION 'approval would exceed bill total; payment remains pending';
  END IF;

  IF _new_paid >= ROUND(COALESCE(_bill.total, 0), 3) - 0.0001 THEN
    _new_paid := ROUND(COALESCE(_bill.total, 0), 3);
    _new_status := 'paid';
  ELSIF _new_paid > 0 THEN
    _new_status := 'partial';
  ELSE
    _new_status := 'unpaid';
  END IF;

  UPDATE public.payments
  SET status = 'approved',
      approved_at = NOW(),
      approved_by = _uid,
      updated_at = NOW()
  WHERE id = _pay.id;

  -- One immutable customer-ledger credit for the exact approved payment.
  INSERT INTO public.customer_ledger (
    tenant_id,
    customer_id,
    entry_type,
    reference_id,
    debit_amount,
    credit_amount,
    description,
    posted_at
  ) VALUES (
    _pay.tenant_id,
    _pay.customer_id,
    'payment',
    _pay.id,
    0.000,
    ROUND(_pay.amount, 3),
    FORMAT('اعتماد سداد فاتورة بمبلغ %s', ROUND(_pay.amount, 3)),
    NOW()
  )
  ON CONFLICT (tenant_id, reference_id, entry_type) DO NOTHING;

  UPDATE public.water_bills
  SET paid_amount = _new_paid,
      status = _new_status,
      paid_at = CASE WHEN _new_status = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
      updated_at = NOW()
  WHERE id = _bill.id;

  -- Rebuild materialized balance from the immutable ledger so the balance and
  -- ledger cannot diverge because of a client-side arithmetic update.
  PERFORM public.recalc_customer_balance(_pay.customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_payment(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Keep the newer transaction RPC on the same accounting path.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Canonical rejection audit fields.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_payment(_payment_id UUID, _reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _uid UUID := auth.uid();
  _pay public.payments%ROWTYPE;
BEGIN
  PERFORM public.assert_authenticated_context();

  SELECT * INTO _pay
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment not found';
  END IF;
  IF _pay.status <> 'pending' THEN
    RAISE EXCEPTION 'only pending payments can be rejected';
  END IF;
  IF NOT (
    public.has_tenant_role(_pay.tenant_id, 'manager')
    OR public.has_tenant_role(_pay.tenant_id, 'admin')
    OR public.has_tenant_role(_pay.tenant_id, 'accountant')
    OR public.has_tenant_role(_pay.tenant_id, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.payments
  SET status = 'rejected',
      rejected_at = NOW(),
      rejected_by = _uid,
      reject_reason = NULLIF(BTRIM(_reason), ''),
      updated_at = NOW()
  WHERE id = _pay.id;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_payment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_payment(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Defensive constraints for future financial rows.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'water_bills_paid_amount_range'
  ) THEN
    ALTER TABLE public.water_bills
      ADD CONSTRAINT water_bills_paid_amount_range
      CHECK (paid_amount IS NULL OR (paid_amount >= 0 AND paid_amount <= total + 0.0001));
  END IF;
END $$;

COMMIT;
