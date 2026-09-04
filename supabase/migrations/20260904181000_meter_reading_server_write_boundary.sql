-- MIZAN: meter readings are sensitive financial evidence.
-- Browser clients must not have a direct INSERT path; the authenticated server
-- function performs identity/proof validation and persists through service_role.

CREATE OR REPLACE FUNCTION public.tg_meter_reading_insert_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _uid UUID := auth.uid();
  _assignment_exists BOOLEAN;
  _is_service_role BOOLEAN :=
    COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    OR current_user = 'service_role';
BEGIN
  IF NOT _is_service_role AND _uid IS NULL THEN
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

  IF NOT _is_service_role THEN
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

-- RLS policies are intentionally retained for reads/updates, but direct browser
-- INSERT is removed. Only the server-side service_role write path can insert.
REVOKE INSERT ON public.water_readings FROM anon, authenticated;
GRANT INSERT ON public.water_readings TO service_role;

REVOKE ALL ON FUNCTION public.tg_meter_reading_insert_gate() FROM PUBLIC;
