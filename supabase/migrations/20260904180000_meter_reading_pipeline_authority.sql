-- MIZAN Meter Reading Pipeline: one authoritative BEFORE INSERT validation pipeline.
-- This migration preserves the existing financial/billing triggers and unique indexes.
-- It removes the previous name-order dependency between multiple reading validators.

BEGIN;

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
BEGIN
  PERFORM public.assert_authenticated_context();
  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN RAISE EXCEPTION 'قراءة غير صالحة: المؤسسة والمشترك والعداد مطلوبة'; END IF;
  IF NEW.client_uuid IS NULL THEN RAISE EXCEPTION 'قراءة غير صالحة: client_uuid مطلوب'; END IF;
  IF NEW.photo_url IS NULL OR btrim(NEW.photo_url) = '' THEN RAISE EXCEPTION 'لا يمكن حفظ قراءة عداد بدون صورة أصلية موثقة'; END IF;
  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN RAISE EXCEPTION 'القراءة الحالية غير صالحة'; END IF;

  _tenant := public.current_tenant_id();
  IF NEW.tenant_id <> _tenant AND NOT public.is_super_admin() THEN RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة'; END IF;
  IF NOT (public.has_tenant_role(NEW.tenant_id, 'reader') OR public.has_tenant_role(NEW.tenant_id, 'manager')) THEN RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة'; END IF;

  SELECT * INTO _meter FROM public.meters WHERE id = NEW.meter_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العداد غير موجود أو لا يتبع المؤسسة الحالية'; END IF;

  SELECT * INTO _assignment FROM public.meter_assignments
  WHERE tenant_id = NEW.tenant_id AND customer_id = NEW.customer_id AND meter_id = NEW.meter_id
    AND started_at::date <= COALESCE(NEW.reading_date, CURRENT_DATE)
    AND (ended_at IS NULL OR ended_at::date >= COALESCE(NEW.reading_date, CURRENT_DATE))
  ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد في تاريخ القراءة'; END IF;

  -- The application creates this exact path from the server-authoritative tenant/client cycle.
  IF NEW.photo_url !~ ('^tenants/' || NEW.tenant_id::text || '/readings/' || NEW.client_uuid::text || '\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'صورة الدليل غير مرتبطة بدورة القراءة الحالية';
  END IF;

  NEW.meter_number := _meter.serial;
  NEW.tenant_id := _meter.tenant_id;
  PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

  SELECT wr.current_reading INTO _previous FROM public.water_readings wr
  WHERE wr.tenant_id = NEW.tenant_id AND wr.meter_id = NEW.meter_id AND wr.status <> 'rejected'
    AND wr.reading_date <= COALESCE(NEW.reading_date, CURRENT_DATE) AND (NEW.id IS NULL OR wr.id <> NEW.id)
  ORDER BY wr.reading_date DESC, wr.created_at DESC LIMIT 1;
  SELECT m.initial_index INTO _initial FROM public.meters m WHERE m.id = NEW.meter_id;
  NEW.previous := COALESCE(_previous, _initial, 0);
  NEW.consumption := GREATEST(NEW.current_reading - NEW.previous, 0);

  SELECT AVG(consumption) INTO _average FROM public.water_readings
  WHERE tenant_id = NEW.tenant_id AND meter_id = NEW.meter_id AND status = 'approved';
  IF NEW.current_reading < NEW.previous THEN
    NEW.consumption := 0; NEW.flag := 'error'; NEW.status := 'pending_approval';
  ELSIF _average IS NOT NULL AND NEW.consumption > (_average * 3) THEN
    NEW.flag := 'suspicious'; NEW.status := 'pending_approval';
  ELSE
    NEW.flag := COALESCE(NEW.flag, 'ok'); NEW.status := COALESCE(NEW.status, 'approved');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_meter_reading_insert_gate ON public.water_readings;
DROP TRIGGER IF EXISTS a_validate_meter_reading ON public.water_readings;
DROP TRIGGER IF EXISTS z_validate_meter_reading ON public.water_readings;
DROP TRIGGER IF EXISTS trg_validate_meter_reading ON public.water_readings;
DROP TRIGGER IF EXISTS tg_reading_before_insert ON public.water_readings;
DROP TRIGGER IF EXISTS trg_meter_reading_pipeline_before_insert ON public.water_readings;
CREATE TRIGGER trg_meter_reading_pipeline_before_insert BEFORE INSERT ON public.water_readings FOR EACH ROW EXECUTE FUNCTION public.tg_meter_reading_pipeline_before_insert();
REVOKE ALL ON FUNCTION public.tg_meter_reading_pipeline_before_insert() FROM PUBLIC;
COMMENT ON FUNCTION public.tg_meter_reading_pipeline_before_insert() IS 'Single authoritative meter-reading BEFORE INSERT validation: tenant, assignment, evidence binding, authoritative meter number, previous reading, consumption and anomaly status.';

COMMIT;
