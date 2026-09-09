-- MIZAN: customer_ledger rows are immutable after insertion.
-- The previous AFTER INSERT rebuild trigger attempted to UPDATE ledger rows,
-- which correctly failed under the ledger immutability guard.
-- Keep the ledger immutable and calculate the new row's running_balance
-- before insertion instead.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_customer_ledger_set_running_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _prior_balance NUMERIC(18,3);
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'Financial ledger entry requires tenant and customer';
  END IF;

  PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

  SELECT ROUND(
    COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0),
    3
  )
  INTO _prior_balance
  FROM public.customer_ledger l
  WHERE l.tenant_id = NEW.tenant_id
    AND l.customer_id = NEW.customer_id;

  NEW.running_balance := ROUND(
    _prior_balance
    + COALESCE(NEW.debit_amount, 0)
    - COALESCE(NEW.credit_amount, 0),
    3
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_customer_ledger_set_running_balance() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_customer_ledger_rebuild_running_balance ON public.customer_ledger;
DROP TRIGGER IF EXISTS trg_customer_ledger_set_running_balance ON public.customer_ledger;

CREATE TRIGGER trg_customer_ledger_set_running_balance
BEFORE INSERT ON public.customer_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_customer_ledger_set_running_balance();

-- This helper necessarily performs UPDATEs on ledger rows and therefore must
-- not be exposed to application sessions while the ledger is immutable.
REVOKE ALL ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID)
  TO postgres;

-- Balance is derived state, not a ledger mutation. Keep recalculation internal.
REVOKE ALL ON FUNCTION public.recalc_customer_balance(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recalc_customer_balance(UUID)
  TO postgres, service_role;

COMMIT;
