-- MIZAN AI — Legacy payment RPC boundary
-- Keep historical RPC names only as compatibility aliases. There must be one
-- implementation of payment accounting and one authorization boundary.
BEGIN;

CREATE OR REPLACE FUNCTION public.process_payment_entry(
  _bill_id UUID,
  _amount NUMERIC(18,3),
  _method TEXT,
  _collected_by TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- _collected_by is intentionally ignored: the canonical path records auth.uid().
  RETURN public.record_payment(_bill_id, _amount, _method, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.process_payment_entry(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_payment_entry(UUID,NUMERIC,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_payment_transaction(_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.reject_payment(_payment_id, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_payment_transaction(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_payment_transaction(UUID) TO authenticated;

COMMIT;
