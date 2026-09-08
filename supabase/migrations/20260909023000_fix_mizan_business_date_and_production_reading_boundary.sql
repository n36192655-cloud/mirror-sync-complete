-- MIZAN: align reading-date validation with the application's business timezone.
-- Production PostgreSQL runs in UTC while Mizan field operations use Asia/Aden.
-- Keep reading_date as a DATE; only the definition of "today" changes.
-- Also remove the obsolete OCR <= 3 server-side cap; attempts are diagnostic.

BEGIN;

CREATE OR REPLACE FUNCTION public.mizan_business_date()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
$$;

REVOKE ALL ON FUNCTION public.mizan_business_date() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mizan_business_date() TO authenticated;

-- The canonical verified boundary keeps the existing security and evidence rules,
-- but evaluates "today" in the Mizan operating timezone rather than UTC.
CREATE OR REPLACE FUNCTION public.insert_verified_meter_reading(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_meter_id uuid,
  p_current_reading numeric,
  p_reading_date date,
  p_client_uuid text,
  p_photo_url text,
  p_lat numeric DEFAULT NULL,
  p_lng numeric DEFAULT NULL,
  p_gps_verified boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _reading_id uuid;
  _tenant_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'المستخدم غير مصادق عليه'; END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_meter_id IS NULL THEN RAISE EXCEPTION 'بيانات القراءة الأساسية مطلوبة'; END IF;
  IF p_current_reading IS NULL OR p_current_reading < 0 THEN RAISE EXCEPTION 'القراءة الحالية غير صالحة'; END IF;
  IF p_reading_date IS NULL OR p_reading_date > public.mizan_business_date() THEN RAISE EXCEPTION 'تاريخ القراءة غير صالح'; END IF;
  IF p_client_uuid IS NULL OR btrim(p_client_uuid) = '' THEN RAISE EXCEPTION 'client_uuid مطلوب'; END IF;
  IF p_photo_url IS NULL OR btrim(p_photo_url) = '' THEN RAISE EXCEPTION 'صورة الدليل مطلوبة'; END IF;
  _tenant_id := public.current_tenant_id();
  IF _tenant_id IS NULL OR _tenant_id <> p_tenant_id THEN RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة'; END IF;
  IF NOT (public.has_tenant_role(p_tenant_id, 'reader') OR public.has_tenant_role(p_tenant_id, 'manager')) THEN RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _user_id AND p.tenant_id = p_tenant_id) THEN RAISE EXCEPTION 'هوية المستخدم لا تتبع المؤسسة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.tenant_id = p_tenant_id) THEN RAISE EXCEPTION 'المشترك غير موجود أو لا يتبع المؤسسة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.meters m WHERE m.id = p_meter_id AND m.tenant_id = p_tenant_id) THEN RAISE EXCEPTION 'العداد غير موجود أو لا يتبع المؤسسة'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.meter_assignments ma
    WHERE ma.tenant_id = p_tenant_id
      AND ma.customer_id = p_customer_id
      AND ma.meter_id = p_meter_id
      AND ma.started_at::date <= p_reading_date
      AND (ma.ended_at IS NULL OR ma.ended_at::date >= p_reading_date)
  ) THEN RAISE EXCEPTION 'العداد غير مرتبط بالمشترك في تاريخ القراءة'; END IF;
  IF p_photo_url !~ ('^tenants/' || p_tenant_id::text || '/readings/' || p_client_uuid::text || '\\.(jpg|png|webp)$') THEN RAISE EXCEPTION 'مسار صورة الدليل غير صالح لدورة القراءة الحالية'; END IF;

  SELECT wr.id INTO _reading_id
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id AND wr.client_uuid = p_client_uuid
  LIMIT 1;
  IF _reading_id IS NOT NULL THEN RETURN _reading_id; END IF;

  INSERT INTO public.water_readings (
    tenant_id, customer_id, meter_id, current_reading, reading_date,
    client_uuid, reader_id, photo_url, lat, lng, gps_verified
  ) VALUES (
    p_tenant_id, p_customer_id, p_meter_id, p_current_reading, p_reading_date,
    p_client_uuid, _user_id, p_photo_url, p_lat, p_lng,
    COALESCE(p_gps_verified, false)
  ) RETURNING id INTO _reading_id;
  RETURN _reading_id;
EXCEPTION WHEN unique_violation THEN
  SELECT wr.id INTO _reading_id
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id AND wr.client_uuid = p_client_uuid
  LIMIT 1;
  IF _reading_id IS NOT NULL THEN RETURN _reading_id; END IF;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_verified_meter_reading(uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_verified_meter_reading(uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean) TO authenticated;

-- Provenance boundary: MANUAL may omit photo; OCR attempts are unbounded diagnostically.
CREATE OR REPLACE FUNCTION public.insert_meter_reading_with_provenance(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_meter_id uuid,
  p_current_reading numeric,
  p_reading_date date,
  p_client_uuid text,
  p_photo_url text,
  p_lat numeric,
  p_lng numeric,
  p_gps_verified boolean,
  p_reading_source text,
  p_attempt_count integer,
  p_failure_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  _reading_id uuid;
  _source text := upper(btrim(coalesce(p_reading_source, '')));
  _existing public.water_readings%ROWTYPE;
  _previous numeric;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'المستخدم غير مصادق عليه'; END IF;
  IF _source NOT IN ('OCR', 'MANUAL', 'MANUAL_FALLBACK') THEN RAISE EXCEPTION 'مصدر القراءة غير صالح'; END IF;
  IF p_attempt_count IS NULL OR p_attempt_count < 0 THEN RAISE EXCEPTION 'عدد المحاولات غير صالح'; END IF;
  IF _source = 'MANUAL_FALLBACK' AND p_attempt_count < 3 THEN RAISE EXCEPTION 'بيانات manual fallback القديمة غير مكتملة'; END IF;
  IF _source IN ('OCR', 'MANUAL_FALLBACK') AND (p_photo_url IS NULL OR btrim(p_photo_url) = '') THEN RAISE EXCEPTION 'الصورة الأصلية مطلوبة لهذا النوع من القراءة'; END IF;
  IF p_current_reading IS NULL OR p_current_reading < 0 THEN RAISE EXCEPTION 'القراءة الحالية غير صالحة'; END IF;
  IF p_reading_date IS NULL OR p_reading_date > public.mizan_business_date() THEN RAISE EXCEPTION 'تاريخ القراءة غير صالح'; END IF;
  IF p_client_uuid IS NULL OR btrim(p_client_uuid) = '' THEN RAISE EXCEPTION 'client_uuid مطلوب'; END IF;
  IF p_photo_url IS NOT NULL AND btrim(p_photo_url) <> ''
     AND p_photo_url !~ ('^tenants/' || p_tenant_id::text || '/readings/' || p_client_uuid::text || '\\.(jpg|png|webp)$')
  THEN RAISE EXCEPTION 'مسار صورة الدليل غير صالح لدورة القراءة الحالية'; END IF;

  SELECT * INTO _existing
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id AND wr.client_uuid = p_client_uuid
  LIMIT 1;
  IF FOUND THEN
    IF _existing.customer_id <> p_customer_id
       OR _existing.meter_id <> p_meter_id
       OR _existing.reading_date <> p_reading_date
       OR _existing.current_reading IS DISTINCT FROM p_current_reading
       OR upper(coalesce(_existing.reading_source, '')) <> _source
       OR coalesce(_existing.photo_url, '') <> coalesce(NULLIF(btrim(p_photo_url), ''), '')
    THEN RAISE EXCEPTION 'client_uuid مستخدم مسبقاً لقراءة مختلفة'; END IF;
    RETURN _existing.id;
  END IF;

  SELECT wr.current_reading INTO _previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id
    AND wr.meter_id = p_meter_id
    AND wr.status = 'approved'
    AND wr.reading_date <= p_reading_date
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;
  IF _previous IS NOT NULL AND p_current_reading < _previous THEN RAISE EXCEPTION 'القراءة الحالية أقل من القراءة السابقة'; END IF;

  INSERT INTO public.water_readings (
    tenant_id, customer_id, meter_id, current_reading, reading_date, client_uuid,
    reader_id, photo_url, lat, lng, gps_verified, reading_source,
    attempt_count, failure_reason, verified_at
  ) VALUES (
    p_tenant_id, p_customer_id, p_meter_id, p_current_reading, p_reading_date,
    p_client_uuid, auth.uid(), NULLIF(btrim(p_photo_url), ''), p_lat, p_lng,
    COALESCE(p_gps_verified, false), _source, p_attempt_count,
    NULLIF(btrim(coalesce(p_failure_reason, '')), ''),
    CASE WHEN _source = 'OCR' THEN now() ELSE NULL END
  ) RETURNING id INTO _reading_id;
  RETURN _reading_id;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO _existing FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id AND wr.client_uuid = p_client_uuid LIMIT 1;
  IF FOUND
     AND _existing.customer_id = p_customer_id
     AND _existing.meter_id = p_meter_id
     AND _existing.reading_date = p_reading_date
     AND _existing.current_reading IS NOT DISTINCT FROM p_current_reading
     AND upper(coalesce(_existing.reading_source, '')) = _source
  THEN RETURN _existing.id; END IF;
  IF FOUND THEN RAISE EXCEPTION 'client_uuid مستخدم مسبقاً لقراءة مختلفة'; END IF;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_meter_reading_with_provenance(uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean,text,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_meter_reading_with_provenance(uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean,text,integer,text) TO authenticated;

COMMIT;
