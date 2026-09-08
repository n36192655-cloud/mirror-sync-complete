-- MIZAN: production reconciliation for verified trigger and financial-state defects.
-- This migration intentionally repairs only derived state and trigger topology.
-- Immutable economic facts are not rewritten.

BEGIN;

-- 1) Keep exactly one authoritative AFTER trigger for reading -> bill issuance.
DROP TRIGGER IF EXISTS tg_reading_after_write ON public.water_readings;
DROP TRIGGER IF EXISTS trg_reading_after_insert ON public.water_readings;
DROP TRIGGER IF EXISTS trg_reading_after_write ON public.water_readings;

CREATE TRIGGER trg_reading_after_write
AFTER INSERT OR UPDATE ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_reading_after_write();

-- 2) Keep exactly one authoritative BEFORE INSERT reading pipeline.
DROP TRIGGER IF EXISTS tg_reading_before_insert ON public.water_readings;
DROP TRIGGER IF EXISTS trg_meter_reading_pipeline_before_insert ON public.water_readings;
DROP TRIGGER IF EXISTS tg_meter_reading_pipeline_before_insert ON public.water_readings;

CREATE TRIGGER tg_meter_reading_pipeline_before_insert
BEFORE INSERT ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_meter_reading_pipeline_before_insert();

-- 3) Rebuild derived running balances from immutable ledger debit/credit facts.
-- Temporarily remove the immutable-ledger guards because running_balance is derived state.
DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON public.customer_ledger;
DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON public.customer_ledger;

WITH ordered AS (
  SELECT
    l.id,
    ROUND(
      SUM(COALESCE(l.debit_amount,0) - COALESCE(l.credit_amount,0)) OVER (
        PARTITION BY l.tenant_id, l.customer_id
        ORDER BY COALESCE(l.posted_at,l.created_at), l.created_at, l.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      3
    ) AS expected_running_balance
  FROM public.customer_ledger l
)
UPDATE public.customer_ledger l
SET running_balance = o.expected_running_balance
FROM ordered o
WHERE l.id = o.id
  AND l.running_balance IS DISTINCT FROM o.expected_running_balance;

CREATE TRIGGER trg_prevent_ledger_update
BEFORE UPDATE ON public.customer_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_prevent_ledger_mutation();

CREATE TRIGGER trg_prevent_ledger_delete
BEFORE DELETE ON public.customer_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_prevent_ledger_mutation();

-- 4) Rebuild customer balance projections from the authoritative ledger.
CREATE OR REPLACE FUNCTION public.reconcile_customer_financial_state(
  _tenant_id UUID,
  _customer_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_debit NUMERIC := 0;
  v_credit NUMERIC := 0;
  v_balance NUMERIC := 0;
BEGIN
  IF _tenant_id IS NULL OR _customer_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(l.debit_amount),0),
    COALESCE(SUM(l.credit_amount),0)
  INTO v_debit, v_credit
  FROM public.customer_ledger l
  WHERE l.tenant_id = _tenant_id
    AND l.customer_id = _customer_id;

  v_balance := ROUND(v_debit - v_credit,3);

  INSERT INTO public.customer_balances (
    tenant_id, customer_id, total_debits, total_credits, current_balance, updated_at
  )
  VALUES (
    _tenant_id, _customer_id, v_debit, v_credit, v_balance, now()
  )
  ON CONFLICT (tenant_id, customer_id)
  DO UPDATE SET
    total_debits = EXCLUDED.total_debits,
    total_credits = EXCLUDED.total_credits,
    current_balance = EXCLUDED.current_balance,
    updated_at = now();

  UPDATE public.customers
  SET balance = v_balance
  WHERE id = _customer_id
    AND tenant_id = _tenant_id;
END;
$$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT tenant_id, customer_id
    FROM public.customer_ledger
    WHERE tenant_id IS NOT NULL AND customer_id IS NOT NULL
  LOOP
    PERFORM public.reconcile_customer_financial_state(r.tenant_id, r.customer_id);
  END LOOP;
END;
$$;

-- 5) Rebuild only derived bill collection fields from approved payments.
WITH approved AS (
  SELECT tenant_id, bill_id, ROUND(COALESCE(SUM(amount),0),3) AS paid_amount
  FROM public.payments
  WHERE status = 'approved'
  GROUP BY tenant_id, bill_id
),
recomputed AS (
  SELECT
    b.id,
    ROUND(COALESCE(a.paid_amount,0),3) AS paid_amount,
    CASE
      WHEN ROUND(COALESCE(a.paid_amount,0),3) <= 0 THEN 'unpaid'
      WHEN ROUND(COALESCE(a.paid_amount,0),3) >= ROUND(COALESCE(b.total,0),3) THEN 'paid'
      ELSE 'partial'
    END AS status
  FROM public.water_bills b
  LEFT JOIN approved a
    ON a.tenant_id = b.tenant_id
   AND a.bill_id = b.id
  WHERE b.status IS DISTINCT FROM 'void'
)
UPDATE public.water_bills b
SET paid_amount = r.paid_amount,
    status = r.status
FROM recomputed r
WHERE b.id = r.id
  AND (
    b.paid_amount IS DISTINCT FROM r.paid_amount
    OR b.status IS DISTINCT FROM r.status
  );

COMMIT;
