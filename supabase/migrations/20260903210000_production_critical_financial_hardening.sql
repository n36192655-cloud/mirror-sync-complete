-- MIZAN AI — Production critical financial hardening
-- Scope: atomic customer billing ledger, payment lifecycle, historical tiered tariffs,
-- frozen invoice protection, and audit-safe balance synchronization.
-- This migration is additive/idempotent and preserves existing data.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Payment lifecycle fields required for an auditable approval workflow.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS client_uuid TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reject_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_client_uuid_uidx
  ON public.payments (tenant_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Never allow a partially paid invoice to be altered silently.
-- Both spellings are accepted because older migrations used both names.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_protect_frozen_invoices()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('paid', 'partial', 'partially_paid', 'void')
     AND (
       ROUND(COALESCE(NEW.subtotal,0),3) IS DISTINCT FROM ROUND(COALESCE(OLD.subtotal,0),3)
       OR ROUND(COALESCE(NEW.total,0),3) IS DISTINCT FROM ROUND(COALESCE(OLD.total,0),3)
       OR ROUND(COALESCE(NEW.amount,0),3) IS DISTINCT FROM ROUND(COALESCE(OLD.amount,0),3)
       OR ROUND(COALESCE(NEW.arrears_snapshot,0),3) IS DISTINCT FROM ROUND(COALESCE(OLD.arrears_snapshot,0),3)
       OR ROUND(COALESCE(NEW.net_amount,0),3) IS DISTINCT FROM ROUND(COALESCE(OLD.net_amount,0),3)
     )
  THEN
    RAISE EXCEPTION 'Financial Security: frozen invoices cannot be modified; use billing_adjustments.';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Historical tariff pricing: apply the complete tier structure, not only
-- the first JSON rate. If no version exists, use the active tariff tiers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.price_consumption_historical(
  _tenant_id UUID,
  _consumption NUMERIC,
  _reading_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _remaining NUMERIC(18,3) := GREATEST(COALESCE(_consumption,0),0);
  _total NUMERIC(18,3) := 0;
  _prev_upper NUMERIC(18,3) := 0;
  _rate NUMERIC(18,3);
  _upper NUMERIC(18,3);
  _fixed NUMERIC(18,3) := 0;
  _version JSONB;
  _tariff_id UUID;
  _used_version BOOLEAN := FALSE;
  _slab NUMERIC(18,3);
  _idx INTEGER;
BEGIN
  IF _tenant_id IS NULL OR _remaining <= 0 THEN
    RETURN 0.000;
  END IF;

  -- Prefer the exact tariff version covering the reading date.
  SELECT tv.id, tv.tariff_id, tv.rate_structure
    INTO _idx, _tariff_id, _version
  FROM public.tariff_versions tv
  WHERE tv.tenant_id = _tenant_id
    AND _reading_date >= tv.effective_from
    AND (tv.effective_to IS NULL OR _reading_date <= tv.effective_to)
  ORDER BY tv.effective_from DESC
  LIMIT 1;

  IF _version IS NOT NULL THEN
    _used_version := TRUE;
    -- Supported snapshot shapes:
    -- [{"upper_bound":100,"rate":10}, {"upper_bound":null,"rate":20}]
    -- [{"upper_bound":100,"rate_per_m3":10}, ...]
    -- {"fixed_fee":5,"tiers":[...]}
    IF jsonb_typeof(_version) = 'object' THEN
      _fixed := COALESCE(NULLIF((_version->>'fixed_fee'),'')::NUMERIC,0);
      _version := COALESCE(_version->'tiers', '[]'::jsonb);
    END IF;

    IF jsonb_typeof(_version) = 'array' THEN
      FOR _idx IN 0 .. GREATEST(jsonb_array_length(_version)-1, -1) LOOP
        IF jsonb_array_length(_version) = 0 THEN EXIT; END IF;
        _rate := COALESCE(
          NULLIF((_version->(_idx)->>'rate_per_m3'),'')::NUMERIC,
          NULLIF((_version->(_idx)->>'rate'),'')::NUMERIC,
          0
        );
        _upper := NULLIF(COALESCE(_version->(_idx)->>'upper_bound', _version->(_idx)->>'to'), '')::NUMERIC;
        IF _upper IS NULL THEN
          _total := _total + (_remaining * GREATEST(_rate,0));
          _remaining := 0;
        ELSE
          _slab := GREATEST(LEAST(_remaining, _upper - _prev_upper),0);
          _total := _total + (_slab * GREATEST(_rate,0));
          _remaining := _remaining - _slab;
          _prev_upper := _upper;
        END IF;
        IF _remaining <= 0 THEN EXIT; END IF;
      END LOOP;
    END IF;
  END IF;

  -- Fallback for tenants whose historical snapshot is not populated yet.
  IF NOT _used_version THEN
    SELECT t.id, COALESCE(t.fixed_fee,0)
      INTO _tariff_id, _fixed
    FROM public.tariffs t
    WHERE t.tenant_id = _tenant_id AND t.is_active = TRUE
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF _tariff_id IS NOT NULL THEN
      _prev_upper := 0;
      FOR _rate, _upper IN
        SELECT tt.rate_per_m3, tt.upper_bound
        FROM public.tariff_tiers tt
        WHERE tt.tenant_id = _tenant_id AND tt.tariff_id = _tariff_id
        ORDER BY tt.tier_order ASC
      LOOP
        IF _remaining <= 0 THEN EXIT; END IF;
        IF _upper IS NULL THEN
          _total := _total + (_remaining * GREATEST(_rate,0));
          _remaining := 0;
        ELSE
          _slab := GREATEST(LEAST(_remaining, _upper - _prev_upper),0);
          _total := _total + (_slab * GREATEST(_rate,0));
          _remaining := _remaining - _slab;
          _prev_upper := _upper;
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN ROUND(_total + _fixed, 3);
END;
$$;

REVOKE ALL ON FUNCTION public.price_consumption_historical(UUID,NUMERIC,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.price_consumption_historical(UUID,NUMERIC,DATE) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Authoritative payment recording RPC. Idempotent by client UUID and
-- reserves the remaining bill balance including other pending payments.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_payment(
  _bill_id UUID,
  _amount NUMERIC,
  _method TEXT,
  _client_uuid TEXT DEFAULT NULL
)
RETURNS UUID
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
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  SELECT * INTO _bill FROM public.water_bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found'; END IF;
  IF _bill.status IN ('paid','void') THEN RAISE EXCEPTION 'bill is not payable'; END IF;

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
    WHERE tenant_id = _bill.tenant_id AND client_uuid = _client_uuid
    LIMIT 1;
    IF _existing IS NOT NULL THEN RETURN _existing; END IF;
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO _approved
  FROM public.payments WHERE bill_id = _bill.id AND status = 'approved';
  SELECT COALESCE(SUM(amount),0) INTO _pending
  FROM public.payments WHERE bill_id = _bill.id AND status = 'pending';

  _remaining := ROUND(COALESCE(_bill.total,0) - _approved - _pending,3);
  IF _remaining <= 0 THEN RAISE EXCEPTION 'bill has no remaining balance'; END IF;
  IF _amount > _remaining + 0.0005 THEN
    RAISE EXCEPTION 'amount exceeds remaining balance';
  END IF;

  INSERT INTO public.payments (
    tenant_id,bill_id,customer_id,amount,method,client_uuid,status,collected_by,payment_date,created_at,updated_at
  ) VALUES (
    _bill.tenant_id,_bill.id,_bill.customer_id,ROUND(_amount,3),COALESCE(NULLIF(_method,''),'cash'),_client_uuid,'pending',_uid,NOW(),NOW(),NOW()
  )
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Authoritative approval RPC. The ledger is posted exactly once through
-- the unique (tenant, reference, entry_type) constraint, and the customer
-- balance is rebuilt from immutable ledger rows in the same transaction.
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
  _approved NUMERIC(18,3);
  _new_paid NUMERIC(18,3);
  _new_status TEXT;
BEGIN
  PERFORM public.assert_authenticated_context();
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO _pay FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment not found'; END IF;

  IF _pay.status = 'approved' THEN
    PERFORM public.recalc_customer_balance(_pay.customer_id);
    RETURN;
  END IF;
  IF _pay.status <> 'pending' THEN RAISE EXCEPTION 'only pending payments can be approved'; END IF;

  IF NOT (
    public.has_tenant_role(_pay.tenant_id,'manager')
    OR public.has_tenant_role(_pay.tenant_id,'admin')
    OR public.has_tenant_role(_pay.tenant_id,'accountant')
    OR public.has_tenant_role(_pay.tenant_id,'super_admin')
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT * INTO _bill FROM public.water_bills WHERE id = _pay.bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found'; END IF;

  PERFORM public.acquire_customer_lock(_pay.tenant_id,_pay.customer_id);

  SELECT COALESCE(SUM(amount),0) INTO _approved
  FROM public.payments
  WHERE bill_id = _bill.id AND status = 'approved' AND id <> _pay.id;

  _new_paid := ROUND(_approved + _pay.amount,3);
  IF _new_paid > ROUND(COALESCE(_bill.total,0),3) + 0.0005 THEN
    RAISE EXCEPTION 'approval would exceed bill total';
  END IF;

  _new_status := CASE
    WHEN _new_paid >= ROUND(COALESCE(_bill.total,0),3) - 0.0005 THEN 'paid'
    WHEN _new_paid > 0 THEN 'partial'
    ELSE 'unpaid'
  END;

  UPDATE public.payments
  SET status='approved', approved_at=NOW(), approved_by=_uid, updated_at=NOW()
  WHERE id=_pay.id;

  INSERT INTO public.customer_ledger (
    tenant_id,customer_id,entry_type,reference_id,debit_amount,credit_amount,
    running_balance,description,posted_at,created_at
  ) VALUES (
    _pay.tenant_id,_pay.customer_id,'payment',_pay.id,0.000,ROUND(_pay.amount,3),
    0.000,FORMAT('اعتماد سداد فاتورة بمبلغ %s',ROUND(_pay.amount,3)),NOW(),NOW()
  ) ON CONFLICT (tenant_id,reference_id,entry_type) DO NOTHING;

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

-- ---------------------------------------------------------------------------
-- 6. Rejection is audit-preserving and never touches the ledger/balance.
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
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT * INTO _pay FROM public.payments WHERE id=_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment not found'; END IF;
  IF _pay.status <> 'pending' THEN RAISE EXCEPTION 'only pending payments can be rejected'; END IF;
  IF NOT (
    public.has_tenant_role(_pay.tenant_id,'manager')
    OR public.has_tenant_role(_pay.tenant_id,'admin')
    OR public.has_tenant_role(_pay.tenant_id,'accountant')
    OR public.has_tenant_role(_pay.tenant_id,'super_admin')
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE public.payments
  SET status='rejected', rejected_at=NOW(), rejected_by=_uid,
      reject_reason=_reason, updated_at=NOW()
  WHERE id=_pay.id AND status='pending';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_payment(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_payment(UUID,TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Bills must enter the customer ledger exactly once when issued/created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_post_bill_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.status,'unpaid') <> 'void'
     AND NEW.customer_id IS NOT NULL
     AND COALESCE(NEW.total,0) > 0
  THEN
    PERFORM public.acquire_customer_lock(NEW.tenant_id,NEW.customer_id);
    INSERT INTO public.customer_ledger (
      tenant_id,customer_id,entry_type,reference_id,debit_amount,credit_amount,
      running_balance,description,posted_at,created_at
    ) VALUES (
      NEW.tenant_id,NEW.customer_id,'bill',NEW.id,ROUND(NEW.total,3),0.000,
      0.000,FORMAT('إصدار فاتورة بمبلغ %s',ROUND(NEW.total,3)),
      COALESCE(NEW.issued_at,NEW.created_at,NOW()),NOW()
    ) ON CONFLICT (tenant_id,reference_id,entry_type) DO NOTHING;
    PERFORM public.recalc_customer_balance(NEW.customer_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_bill_to_ledger ON public.water_bills;
CREATE TRIGGER trg_post_bill_to_ledger
AFTER INSERT ON public.water_bills
FOR EACH ROW EXECUTE FUNCTION public.tg_post_bill_to_ledger();

-- ---------------------------------------------------------------------------
-- 8. Close the remaining RLS gap for accountants on the customer ledger.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_select_customer_ledger ON public.customer_ledger;
CREATE POLICY tenant_select_customer_ledger
ON public.customer_ledger
FOR SELECT TO authenticated
USING (
  tenant_id = public.current_tenant_id()
  AND (
    public.has_tenant_role(tenant_id,'super_admin')
    OR public.has_tenant_role(tenant_id,'manager')
    OR public.has_tenant_role(tenant_id,'admin')
    OR public.has_tenant_role(tenant_id,'accountant')
    OR public.has_tenant_role(tenant_id,'collector')
    OR customer_id = auth.uid()
  )
);

COMMIT;
