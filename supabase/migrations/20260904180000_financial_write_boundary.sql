-- MIZAN AI — Financial write boundary
-- Production invariant: authenticated clients may read financial state, but may
-- not mutate authoritative payment or bill state outside the SECURITY DEFINER RPCs.
-- The canonical RPCs remain writable because they execute as their owner.
BEGIN;

-- Payments are created/approved/rejected only through the canonical lifecycle RPCs.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payments FROM PUBLIC, anon, authenticated;

-- Bills are authoritative accounting state. Client sessions must not mutate them
-- directly; bill issuance and payment settlement are performed by server-side
-- SECURITY DEFINER functions/triggers.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.water_bills FROM PUBLIC, anon, authenticated;

COMMIT;
