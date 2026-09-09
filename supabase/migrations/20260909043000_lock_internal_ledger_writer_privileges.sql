BEGIN;

-- post_ledger_entry is an internal SECURITY DEFINER helper used by trusted
-- database code. It must never be callable by client roles because it accepts
-- arbitrary tenant/customer/reference/amount arguments.
REVOKE EXECUTE ON FUNCTION public.post_ledger_entry(uuid, uuid, text, uuid, numeric, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_ledger_entry(uuid, uuid, text, uuid, numeric, numeric, text)
  TO postgres;

COMMIT;
