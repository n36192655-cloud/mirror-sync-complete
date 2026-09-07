-- MIZAN: authoritative reconciliation of derived financial state.
-- Scope is intentionally limited to derived fields. Historical economic facts
-- (ledger debit/credit, bill charges, payment amounts, arrears snapshots) are not rewritten.
-- The tenant model is intentionally left unchanged.

BEGIN;

-- Rebuild customer_balances from the immutable customer ledger.
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

  PERFORM public.acquire_customer_lock(_tenant_id, _customer_id);

  -- The ledger remains the authoritative source for customer balance.
  SELECT
    COALESCE(SUM(l.debit_amount), 0),
    COALESCE(SUM(l.credit_amount), 0)
  INTO v_debit, v_credit
  FROM public.customer_ledger l
  WHERE l.tenant_id = _tenant_id
    AND l.customer_id = _customer_id;

  v_balance := ROUND(v_debit - v_credit, 3);

  -- Rebuild every running balance from ordered debit/credit facts.
  PERFORM public.rebuild_customer_ledger_running_balance(_tenant_id, _customer_id);

  -- Synchronize only derived balance totals; never alter ledger facts.
  INSERT INTO public.customer_balances (
    tenant_id,
    customer_id,
    total_debit,
    total_credit,
    current_balance
  )
  VALUES (
    _tenant_id,
    _customer_id,
    v_debit,
    v_credit,
    v_balance
  )
  ON CONFLICT (tenant_id, customer_id)
  DO UPDATE SET
    total_debit = EXCLUDED.total_debit,
    total_credit = EXCLUDED.total_credit,
    current_balance = EXCLUDED.current_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_customer_financial_state(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_customer_financial_state(UUID, UUID)
  TO authenticated, service_role;

-- Reconcile all existing customers from ledger facts.
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

-- Rebuild derived bill collection state from approved payments only.
-- Void bills are deliberately excluded from automatic status rewriting.
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
      WHEN ROUND(COALESCE(a.approved_amount, 0), 3) >= ROUND(COALESCE(b.total, 0), 3) THEN 'paid'
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

-- Financial invariant report for operational verification.
CREATE OR REPLACE FUNCTION public.verify_financial_state()
RETURNS TABLE (
  check_name TEXT,
  mismatch_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH ledger_balance AS (
    SELECT tenant_id, customer_id,
      ROUND(COALESCE(SUM(debit_amount),0) - COALESCE(SUM(credit_amount),0),3) AS expected_balance
    FROM public.customer_ledger
    GROUP BY tenant_id, customer_id
  ),
  balance_mismatch AS (
    SELECT COUNT(*)::BIGINT AS n
    FROM ledger_balance l
    LEFT JOIN public.customer_balances b
      ON b.tenant_id=l.tenant_id AND b.customer_id=l.customer_id
    WHERE b.current_balance IS DISTINCT FROM l.expected_balance
       OR b.total_debit IS DISTINCT FROM (
         SELECT ROUND(COALESCE(SUM(x.debit_amount),0),3)
         FROM public.customer_ledger x
         WHERE x.tenant_id=l.tenant_id AND x.customer_id=l.customer_id
       )
       OR b.total_credit IS DISTINCT FROM (
         SELECT ROUND(COALESCE(SUM(x.credit_amount),0),3)
         FROM public.customer_ledger x
         WHERE x.tenant_id=l.tenant_id AND x.customer_id=l.customer_id
       )
  ),
  bill_payment_mismatch AS (
    SELECT COUNT(*)::BIGINT AS n
    FROM public.water_bills b
    LEFT JOIN (
      SELECT tenant_id, bill_id, ROUND(COALESCE(SUM(amount),0),3) AS paid_amount
      FROM public.payments
      WHERE status='approved'
      GROUP BY tenant_id, bill_id
    ) p ON p.tenant_id=b.tenant_id AND p.bill_id=b.id
    WHERE b.status IS DISTINCT FROM 'void'
      AND ROUND(COALESCE(b.paid_amount,0),3)
          IS DISTINCT FROM ROUND(COALESCE(p.paid_amount,0),3)
  )
  SELECT 'customer_balance_vs_ledger', n FROM balance_mismatch
  UNION ALL
  SELECT 'bill_paid_amount_vs_approved_payments', n FROM bill_payment_mismatch;
$$;

REVOKE ALL ON FUNCTION public.verify_financial_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_financial_state() TO authenticated, service_role;

COMMIT;
