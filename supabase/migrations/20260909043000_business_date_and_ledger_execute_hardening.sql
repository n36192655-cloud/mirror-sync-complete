-- MIZAN: align accounting-period checks with the Asia/Aden business date and
-- close the internal ledger posting boundary to application roles.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_payment(
  _bill_id uuid,
  _amount numeric,
  _method text,
  _client_uuid text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _bill public.water_bills%ROWTYPE;
  _approved NUMERIC; _pending NUMERIC; _remaining NUMERIC;
  _existing UUID; _new_id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  SELECT * INTO _bill FROM public.water_bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found'; END IF;
  IF _bill.status = 'void' THEN RAISE EXCEPTION 'bill is void'; END IF;

  IF NOT (public.has_tenant_role(_bill.tenant_id, 'collector')
          OR public.has_tenant_role(_bill.tenant_id, 'manager')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF public.is_period_closed(_bill.tenant_id, public.mizan_business_date()) THEN
    RAISE EXCEPTION 'closed accounting period';
  END IF;

  IF _client_uuid IS NOT NULL THEN
    SELECT id INTO _existing FROM public.payments
     WHERE tenant_id = _bill.tenant_id AND client_uuid = _client_uuid;
    IF _existing IS NOT NULL THEN RETURN _existing; END IF;
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO _approved FROM public.payments
   WHERE bill_id = _bill.id AND status = 'approved';
  SELECT COALESCE(SUM(amount),0) INTO _pending FROM public.payments
   WHERE bill_id = _bill.id AND status = 'pending';

  _remaining := _bill.total - _approved - _pending;
  IF _amount > _remaining + 0.0001 THEN
    RAISE EXCEPTION 'amount exceeds remaining balance (%)', ROUND(_remaining, 2);
  END IF;

  INSERT INTO public.payments (tenant_id, bill_id, customer_id, amount, method, client_uuid, status, created_by)
  VALUES (_bill.tenant_id, _bill.id, _bill.customer_id, _amount, COALESCE(_method,'cash'), _client_uuid, 'pending', _uid)
  RETURNING id INTO _new_id;
  RETURN _new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid,uuid,text,uuid,numeric,numeric,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid,uuid,text,uuid,numeric,numeric,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid,uuid,text,uuid,numeric,numeric,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid,uuid,text,uuid,numeric,numeric,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.post_ledger_entry(uuid,uuid,text,uuid,numeric,numeric,text) TO postgres;

COMMIT;
