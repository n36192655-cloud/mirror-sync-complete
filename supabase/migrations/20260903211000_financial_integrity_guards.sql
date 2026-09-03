-- MIZAN AI — Financial integrity guards and reconciliation checks
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_amount_positive') THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_status_check') THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_status_check CHECK (status IN ('pending','approved','rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='water_bills_paid_amount_nonnegative') THEN
    ALTER TABLE public.water_bills ADD CONSTRAINT water_bills_paid_amount_nonnegative CHECK (COALESCE(paid_amount,0) >= 0);
  END IF;
END $$;

-- One authoritative reconciliation function for production monitoring.
CREATE OR REPLACE FUNCTION public.verify_financial_integrity()
RETURNS TABLE(check_name TEXT,status TEXT,details TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n BIGINT;
BEGIN
  PERFORM public.assert_authenticated_context();

  SELECT COUNT(*) INTO n
  FROM public.customer_balances cb
  LEFT JOIN (
    SELECT tenant_id,customer_id,
           ROUND(SUM(debit_amount-credit_amount),3) AS ledger_balance
    FROM public.customer_ledger GROUP BY tenant_id,customer_id
  ) l ON l.tenant_id=cb.tenant_id AND l.customer_id=cb.customer_id
  WHERE ROUND(cb.current_balance,3) <> COALESCE(l.ledger_balance,0);
  RETURN QUERY SELECT 'Customer balance = ledger'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s balance mismatches',n);

  SELECT COUNT(*) INTO n
  FROM public.water_bills b
  LEFT JOIN (
    SELECT bill_id,ROUND(SUM(amount) FILTER (WHERE status='approved'),3) approved
    FROM public.payments GROUP BY bill_id
  ) p ON p.bill_id=b.id
  WHERE b.status <> 'void'
    AND ROUND(COALESCE(b.paid_amount,0),3) <> COALESCE(p.approved,0);
  RETURN QUERY SELECT 'Bill paid_amount = approved payments'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s bill/payment mismatches',n);

  SELECT COUNT(*) INTO n
  FROM public.water_bills b
  LEFT JOIN (
    SELECT bill_id,SUM(amount) approved FROM public.payments WHERE status='approved' GROUP BY bill_id
  ) p ON p.bill_id=b.id
  WHERE b.status <> 'void' AND COALESCE(p.approved,0) > COALESCE(b.total,0)+0.0005;
  RETURN QUERY SELECT 'No bill overpayment'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s overpaid bills',n);

  SELECT COUNT(*) INTO n
  FROM public.water_bills b
  LEFT JOIN public.customer_ledger l
    ON l.tenant_id=b.tenant_id AND l.reference_id=b.id AND l.entry_type='bill'
  WHERE b.status <> 'void' AND COALESCE(b.total,0)>0 AND l.id IS NULL;
  RETURN QUERY SELECT 'Every issued bill has ledger posting'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s bills missing ledger entries',n);

  SELECT COUNT(*) INTO n
  FROM public.payments p
  LEFT JOIN public.customer_ledger l
    ON l.tenant_id=p.tenant_id AND l.reference_id=p.id AND l.entry_type='payment'
  WHERE p.status='approved' AND l.id IS NULL;
  RETURN QUERY SELECT 'Every approved payment has ledger posting'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s approved payments missing ledger entries',n);

  SELECT COUNT(*) INTO n
  FROM public.customer_ledger
  WHERE debit_amount < 0 OR credit_amount < 0
     OR (debit_amount > 0 AND credit_amount > 0)
     OR (debit_amount = 0 AND credit_amount = 0);
  RETURN QUERY SELECT 'Ledger direction/amount validity'::TEXT, CASE WHEN n=0 THEN 'PASSED' ELSE 'FAILED' END,
    FORMAT('%s invalid ledger rows',n);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_financial_integrity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_financial_integrity() TO authenticated, service_role;

COMMIT;
