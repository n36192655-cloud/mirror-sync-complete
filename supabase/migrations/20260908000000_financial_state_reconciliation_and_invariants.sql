-- MIZAN: authoritative reconciliation of derived financial state.
-- Scope: repair derived balances and derived bill collection state only.
-- Historical economic facts (ledger debit/credit, bill charges, payment amounts,
-- and arrears snapshots) are never rewritten by this migration.
-- The tenant model is intentionally left unchanged.

BEGIN;

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

  WITH ordered AS (
    SELECT
      l.id,
      ROUND(
        SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) OVER (
          PARTITION BY l.tenant_id, l.customer_id
          ORDER BY l.posted_at, l.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        3
      ) AS expected_running_balance
    FROM public.customer_ledger l
    WHERE l.tenant_id = _tenant_id
      AND l.customer_id = _customer_id
  )
  UPDATE public.customer_ledger l
  SET running_balance = o.expected_running_balance
  FROM ordered o
  WHERE l.id = o.id
    AND l.running_balance IS DISTINCT FROM o.expected_running_balance;

  SELECT
    COALESCE(SUM(l.debit_amount), 0),
    COALESCE(SUM(l.credit_amount), 0)
  INTO v_debit, v_credit
  FROM public.customer_ledger l
  WHERE l.tenant_id = _tenant_id
    AND l.customer_id = _customer_id;

  v_balance := ROUND(v_debit - v_credit, 3);

  INSERT INTO public.customer_balances (
    tenant_id, customer_id, total_debits, total_credits, current_balance
  )
  VALUES (
    _tenant_id, _customer_id, v_debit, v_credit, v_balance
  )
  ON CONFLICT (tenant_id, customer_id)
  DO UPDATE SET
    total_debits = EXCLUDED.total_debits,
    total_credits = EXCLUDED.total_credits,
    current_balance = EXCLUDED.current_balance,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_customer_financial_state(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_customer_financial_state(UUID, UUID)
  TO authenticated, service_role;

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
    PERFORM public.reconcile_customer_financial_state(r.tenant_id, r.customer_id);
  END LOOP;
END;
$$;

-- Rebuild only derived bill collection fields from approved payments.
-- Void bills are intentionally excluded from automatic status rewriting.
WITH approved AS (
  SELECT
    p.tenant_id,
    p.bill_id,
    ROUND(COALESCE(SUM(p.amount), 0), 3) AS approved_amount
  FROM public.payments p
  WHERE p.status = 'approved'
  GROUP BY p.tenant_id, p.bill_id
),
recomputed AS (
  SELECT
    b.id,
    ROUND(COALESCE(a.approved_amount, 0), 3) AS paid_amount,
    CASE
      WHEN ROUND(COALESCE(a.approved_amount, 0), 3) <= 0 THEN 'unpaid'
      WHEN ROUND(COALESCE(a.approved_amount, 0), 3)
           >= ROUND(COALESCE(b.total, 0), 3) THEN 'paid'
      ELSE 'partial'
    END AS status
  FROM public.water_bills b
  LEFT JOIN approved a
    ON a.tenant_id = b.tenant_id
   AND a.bill_id = b.id
  WHERE b.status IS DISTINCT FROM 'void'
)
UPDATE public.water_bills b
SET
  paid_amount = r.paid_amount,
  status = r.status
FROM recomputed r
WHERE b.id = r.id
  AND (
    b.paid_amount IS DISTINCT FROM r.paid_amount
    OR b.status IS DISTINCT FROM r.status
  );

COMMIT;
