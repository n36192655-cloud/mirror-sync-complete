-- MIZAN: final insert gate for field readings.
-- Runs before the legacy reading trigger so the client-selected customer cannot
-- be silently replaced before we validate the assignment.

CREATE OR REPLACE FUNCTION public.tg_meter_reading_insert_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _uid UUID := auth.uid();
  _assignment_exists BOOLEAN;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: المشترك والعداد والمؤسسة مطلوبة';
  END IF;

  IF NEW.photo_url IS NULL OR btrim(NEW.photo_url) = '' THEN
    RAISE EXCEPTION 'لا يمكن حفظ قراءة عداد بدون صورة أصلية موثقة';
  END IF;

  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;

  IF NEW.tenant_id <> public.current_tenant_id()
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
  END IF;

  IF NOT (
    public.has_tenant_role(NEW.tenant_id, 'reader')
    OR public.has_tenant_role(NEW.tenant_id, 'manager')
  ) THEN
    RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.meter_assignments ma
    WHERE ma.tenant_id = NEW.tenant_id
      AND ma.customer_id = NEW.customer_id
      AND ma.meter_id = NEW.meter_id
      AND ma.started_at::date <= COALESCE(NEW.reading_date, CURRENT_DATE)
      AND (ma.ended_at IS NULL OR ma.ended_at::date >= COALESCE(NEW.reading_date, CURRENT_DATE))
  ) INTO _assignment_exists;

  IF NOT _assignment_exists THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد في تاريخ القراءة';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_meter_reading_insert_gate ON public.water_readings;
CREATE TRIGGER aa_meter_reading_insert_gate
BEFORE INSERT ON public.water_readings
FOR EACH ROW EXECUTE FUNCTION public.tg_meter_reading_insert_gate();

REVOKE ALL ON FUNCTION public.tg_meter_reading_insert_gate() FROM PUBLIC;
