-- SECURITY HARDENING: post_ledger_entry is an internal SECURITY DEFINER writer.
-- It must not be callable by end users because its parameters can otherwise
-- create arbitrary debit/credit entries for any tenant/customer.
REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid, uuid, text, uuid, numeric, numeric, text)
FROM PUBLIC, anon, authenticated;

-- Internal server-side routines remain able to call it as their definer.
