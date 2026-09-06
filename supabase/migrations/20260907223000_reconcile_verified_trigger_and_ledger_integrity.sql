-- MIZAN: reconcile verified production trigger topology and derived ledger balances.
-- Evidence basis:
--   * water_readings had two AFTER triggers calling tg_reading_after_write().
--   * a legacy BEFORE INSERT trigger coexisted with the authoritative pipeline design.
--   * customer_ledger.running_balance values were observed to disagree with the
--     debit-minus-credit ledger calculation for multiple customers.
--
-- Scope:
--   1) Keep exactly one authoritative meter-reading BEFORE INSERT pipeline.
--   2) Keep exactly one bill-issuance AFTER INSERT OR UPDATE trigger.
--   3) Rebuild derived running_balance values from immutable debit/credit facts.
--   4) Prevent future inserts from leaving running_balance stale.
--
-- No debit_amount, credit_amount, bill amount, payment amount, or historical
-- economic transaction is changed by this migration.

BEGIN;

-- ============================================================================
-- 1. Canonical water-reading trigger topology.
-- ============================================================================

-- Remove the verified duplicate legacy trigger. The remaining canonical trigger
-- below preserves the intended AFTER INSERT OR UPDATE bill-issuance behavior.
DROP TRIGGER IF EXISTS tg_reading_after_write ON public.water_readings;
DROP TRIGGER IF EXISTS trg_reading_after_insert ON public.water_readings;

CREATE TRIGGER trg_reading_after_write
AFTER INSERT OR UPDATE ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_reading_after_write();

-- Remove the legacy competing BEFORE INSERT implementation and retain exactly
-- the authoritative pipeline introduced by the verified root-cause migrations.
DROP TRIGGER IF EXISTS tg_reading_before_insert ON public.water_readings;
DROP TRIGGER IF EXISTS trg_meter_reading_pipeline_before_insert ON public.water_readings;

CREATE TRIGGER trg_meter_reading_pipeline_before_insert
BEFORE INSERT ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_meter_reading_pipeline_before_insert();

-- ============================================================================
-- 2. Authoritative rebuild of derived customer_ledger.running_balance.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rebuild_customer_ledger_running_balance(
  _tenant_id UUID,
  _customer_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF _tenant_id IS NULL OR _customer_id IS NULL THEN
    RETURN;
  END IF;

  -- Serialize concurrent financial writes for the same customer.
  PERFORM public.acquire_customer_lock(_tenant_id, _customer_id);

  WITH ordered AS (
    SELECT
      l.id,
      ROUND(
        SUM(
          COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)
        ) OVER (
          PARTITION BY l.tenant_id, l.customer_id
          ORDER BY
            COALESCE(l.posted_at, l.created_at),
            l.created_at,
            l.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        3
      ) AS expected_running_balance
    FROM public.customer_ledger l
    WHERE l.tenant_id = _tenant_id
      AND l.customer_id = _customer_id
  )
  UPDATE public.customer_ledger l
  SET running_balance = ordered.expected_running_balance
  FROM ordered
  WHERE l.id = ordered.id
    AND l.running_balance IS DISTINCT FROM ordered.expected_running_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID)
  TO authenticated, service_role;

-- Repair all currently stored derived balances from the authoritative
-- debit/credit ledger facts. No financial amount is rewritten.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT tenant_id, customer_id
    FROM public.customer_ledger
    WHERE tenant_id IS NOT NULL
      AND customer_id IS NOT NULL
  LOOP
    PERFORM public.rebuild_customer_ledger_running_balance(
      r.tenant_id,
      r.customer_id
    );
  END LOOP;
END;
$$;

-- ============================================================================
-- 3. Keep the derived running balance synchronized for future ledger inserts.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tg_customer_ledger_rebuild_running_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.rebuild_customer_ledger_running_balance(
    NEW.tenant_id,
    NEW.customer_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_ledger_rebuild_running_balance
  ON public.customer_ledger;

CREATE TRIGGER trg_customer_ledger_rebuild_running_balance
AFTER INSERT ON public.customer_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_customer_ledger_rebuild_running_balance();

COMMIT;
