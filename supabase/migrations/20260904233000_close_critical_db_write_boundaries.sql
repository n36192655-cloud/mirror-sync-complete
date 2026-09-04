-- MIZAN: close critical database write boundaries.
-- Scope: meter-reading service-role compatibility, payment direct-DML lockdown,
-- and PostgreSQL enforcement of geo-only customer updates for reader/collector.
-- No new product features; existing workflows are preserved.

BEGIN;

/* -------------------------------------------------------------------------
   1) WATER READINGS — explicit service_role/server write boundary

   The application persists verified readings through supabaseAdmin (service_role).
   The final trigger must therefore distinguish the trusted server write context
   from a browser-authenticated INSERT. Browser INSERT is already revoked by the
   preceding server-write-boundary migration.

   We deliberately keep all data-integrity checks for service_role writes:
   required identifiers, evidence path binding, meter existence/tenant binding,
   assignment validity, authoritative meter serial, previous reading and anomaly
   calculation. Only checks whose meaning depends on auth.uid()/the caller's
   session role are evaluated against NEW.reader_id for the service path.
   ------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.tg_meter_reading_pipeline_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _meter public.meters%ROWTYPE;
  _assignment public.meter_assignments%ROWTYPE;
  _previous NUMERIC;
  _average NUMERIC;
  _tenant UUID;
  _initial NUMERIC;
  _is_service_role BOOLEAN :=
    COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    OR current_user = 'service_role';
BEGIN
  IF NOT _is_service_role THEN
    PERFORM public.assert_authenticated_context();
  END IF;

  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: المؤسسة والمشترك والعداد مطلوبة';
  END IF;
  IF NEW.client_uuid IS NULL OR btrim(NEW.client_uuid) = '' THEN
    RAISE EXCEPTION 'قراءة غير صالحة: client_uuid مطلوب';
  END IF;
  IF NEW.photo_url IS NULL OR btrim(NEW.photo_url) = '' THEN
    RAISE EXCEPTION 'لا يمكن حفظ قراءة عداد بدون صورة أصلية موثقة';
  END IF;
  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;

  _tenant := public.current_tenant_id();

  IF _is_service_role THEN
    -- The server function binds reader_id to the authenticated user in the
    -- signed verification proof. Re-check that identity at the DB boundary.
    IF NEW.reader_id IS NULL THEN
      RAISE EXCEPTION 'قراءة غير صالحة: هوية قارئ القراءة مطلوبة';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = NEW.reader_id
        AND p.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'هوية قارئ القراءة لا تتبع المؤسسة';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = NEW.reader_id
        AND ur.tenant_id = NEW.tenant_id
        AND ur.role IN ('reader','manager')
    ) THEN
      RAISE EXCEPTION 'مستخدم القراءة غير مخول لتسجيل قراءة';
    END IF;
  ELSE
    IF NEW.tenant_id <> _tenant AND NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
    END IF;
    IF NOT (
      public.has_tenant_role(NEW.tenant_id, 'reader')
      OR public.has_tenant_role(NEW.tenant_id, 'manager')
    ) THEN
      RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
    END IF;
  END IF;

  SELECT * INTO _meter
  FROM public.meters
  WHERE id = NEW.meter_id AND tenant_id = NEW.tenant_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العداد غير موجود أو لا يتبع المؤسسة الحالية';
  END IF;

  SELECT * INTO _assignment
  FROM public.meter_assignments
  WHERE tenant_id = NEW.tenant_id
    AND customer_id = NEW.customer_id
    AND meter_id = NEW.meter_id
    AND started_at::date <= COALESCE(NEW.reading_date, CURRENT_DATE)
    AND (ended_at IS NULL OR ended_at::date >= COALESCE(NEW.reading_date, CURRENT_DATE))
  ORDER BY started_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد في تاريخ القراءة';
  END IF;

  IF NEW.photo_url !~ ('^tenants/' || NEW.tenant_id::text || '/readings/' || NEW.client_uuid::text || '\\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'صورة الدليل غير مرتبطة بدورة القراءة الحالية';
  END IF;

  NEW.meter_number := _meter.serial;
  NEW.tenant_id := _meter.tenant_id;
  PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

  SELECT wr.current_reading INTO _previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = NEW.tenant_id
    AND wr.meter_id = NEW.meter_id
    AND wr.status <> 'rejected'
    AND wr.reading_date <= COALESCE(NEW.reading_date, CURRENT_DATE)
    AND (NEW.id IS NULL OR wr.id <> NEW.id)
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;

  SELECT m.initial_index INTO _initial
  FROM public.meters m
  WHERE m.id = NEW.meter_id;

  NEW.previous := COALESCE(_previous, _initial, 0);
  NEW.consumption := GREATEST(NEW.current_reading - NEW.previous, 0);

  SELECT AVG(consumption) INTO _average
  FROM public.water_readings
  WHERE tenant_id = NEW.tenant_id
    AND meter_id = NEW.meter_id
    AND status = 'approved';

  IF NEW.current_reading < NEW.previous THEN
    NEW.consumption := 0;
    NEW.flag := 'error';
    NEW.status := 'pending_approval';
  ELSIF _average IS NOT NULL AND NEW.consumption > (_average * 3) THEN
    NEW.flag := 'suspicious';
    NEW.status := 'pending_approval';
  ELSE
    NEW.flag := COALESCE(NEW.flag, 'ok');
    NEW.status := COALESCE(NEW.status, 'approved');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_meter_reading_pipeline_before_insert() FROM PUBLIC;

-- The old gate is no longer part of the active trigger chain. Remove it so the
-- database has one unambiguous meter-reading INSERT boundary.
DROP TRIGGER IF EXISTS aa_meter_reading_insert_gate ON public.water_readings;
DROP FUNCTION IF EXISTS public.tg_meter_reading_insert_gate();

-- Browser clients must not have a direct INSERT route.
REVOKE INSERT ON public.water_readings FROM anon, authenticated;
GRANT INSERT ON public.water_readings TO service_role;

/* -------------------------------------------------------------------------
   2) PAYMENTS — RPC/server write boundary

   SELECT remains available through the existing tenant RLS policy. Sensitive
   INSERT/UPDATE/DELETE is removed from the authenticated role. Existing
   SECURITY DEFINER RPCs remain the write path and keep their workflow:
   record_payment -> pending -> approve/reject -> ledger/balance/audit logic.
   ------------------------------------------------------------------------- */

REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon, authenticated;
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;

/* -------------------------------------------------------------------------
   3) CUSTOMERS — PostgreSQL enforcement for geo-only reader/collector UPDATE

   Managers retain their existing full customer-management workflow. Readers and
   collectors retain only the already-intended geographic update capability.
   The trigger compares the complete row while excluding only geo fields and the
   automatic updated_at field, so frontend/API omissions cannot weaken the rule.
   ------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.tg_protect_customer_geo_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT (
    public.has_tenant_role(OLD.tenant_id, 'manager')
    OR public.has_tenant_role(OLD.tenant_id, 'super_admin')
  ) AND (
    public.has_tenant_role(OLD.tenant_id, 'reader')
    OR public.has_tenant_role(OLD.tenant_id, 'collector')
  ) THEN
    IF (to_jsonb(NEW) - ARRAY['latitude','longitude','geo_accuracy','geo_captured_at','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['latitude','longitude','geo_accuracy','geo_captured_at','updated_at'])
    THEN
      RAISE EXCEPTION 'صلاحية المستخدم تقتصر على تحديث بيانات موقع المشترك';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_customer_geo_update ON public.customers;
CREATE TRIGGER trg_protect_customer_geo_update
BEFORE UPDATE ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.tg_protect_customer_geo_update();

REVOKE ALL ON FUNCTION public.tg_protect_customer_geo_update() FROM PUBLIC;

COMMIT;
