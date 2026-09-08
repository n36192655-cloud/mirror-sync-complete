-- MIZAN: harden the shared meter-reading persistence boundary.
-- Manual readings may omit photo; OCR readings may not.
-- Both sources still enter the same water_readings INSERT trigger and therefore
-- the same consumption -> billing -> arrears -> ledger -> balance chain.

BEGIN;

-- The authoritative BEFORE INSERT pipeline must distinguish the evidence rule
-- by source. MANUAL may legitimately have no photo; OCR and legacy fallback may not.
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
  _source TEXT;
BEGIN
  PERFORM public.assert_authenticated_context();

  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: المؤسسة والمشترك والعداد مطلوبة';
  END IF;
  IF NEW.client_uuid IS NULL OR btrim(NEW.client_uuid) = '' THEN
    RAISE EXCEPTION 'قراءة غير صالحة: client_uuid مطلوب';
  END IF;
  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;

  _source := upper(coalesce(NEW.reading_source, 'OCR'));
  IF _source NOT IN ('OCR', 'MANUAL', 'MANUAL_FALLBACK') THEN
    RAISE EXCEPTION 'مصدر القراءة غير صالح';
  END IF;
  NEW.reading_source := _source;

  IF _source <> 'MANUAL' AND (NEW.photo_url IS NULL OR btrim(NEW.photo_url) = '') THEN
    RAISE EXCEPTION 'صورة الدليل مطلوبة لقراءة OCR أو القراءة اليدوية القديمة';
  END IF;

  _tenant := public.current_tenant_id();
  IF NEW.tenant_id <> _tenant AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
  END IF;
  IF NOT (public.has_tenant_role(NEW.tenant_id, 'reader') OR public.has_tenant_role(NEW.tenant_id, 'manager')) THEN
    RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
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

  IF NEW.photo_url IS NOT NULL AND btrim(NEW.photo_url) <> ''
     AND NEW.photo_url !~ ('^tenants/' || NEW.tenant_id::text || '/readings/' || NEW.client_uuid::text || '\\.(jpg|png|webp)$') THEN
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

-- Rebuild the provenance RPC as the single persistence boundary for OCR and MANUAL.
-- Crucially, reading_source is present during BEFORE INSERT, so the trigger can
-- enforce the correct photo rule without a post-insert UPDATE loophole.
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
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _tenant_id UUID;
  _source TEXT := upper(coalesce(p_reading_source, ''));
  _reading_id UUID;
  _existing public.water_readings%ROWTYPE;
  _previous NUMERIC;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مصادق عليه';
  END IF;
  IF _source NOT IN ('OCR', 'MANUAL', 'MANUAL_FALLBACK') THEN
    RAISE EXCEPTION 'مصدر القراءة غير صالح';
  END IF;
  IF p_attempt_count IS NULL OR p_attempt_count < 0 THEN
    RAISE EXCEPTION 'عدد المحاولات غير صالح';
  END IF;
  IF _source <> 'MANUAL' AND (p_photo_url IS NULL OR btrim(p_photo_url) = '') THEN
    RAISE EXCEPTION 'صورة الدليل مطلوبة لقراءة OCR أو القراءة اليدوية القديمة';
  END IF;
  IF _source = 'MANUAL_FALLBACK' AND p_attempt_count < 3 THEN
    RAISE EXCEPTION 'بيانات manual fallback القديمة غير مكتملة';
  END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_meter_id IS NULL THEN
    RAISE EXCEPTION 'بيانات القراءة الأساسية مطلوبة';
  END IF;
  IF p_current_reading IS NULL OR p_current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;
  IF p_reading_date IS NULL OR p_reading_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'تاريخ القراءة غير صالح';
  END IF;
  IF p_client_uuid IS NULL OR btrim(p_client_uuid) = '' THEN
    RAISE EXCEPTION 'client_uuid مطلوب';
  END IF;

  _tenant_id := public.current_tenant_id();
  IF _tenant_id IS NULL OR _tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
  END IF;
  IF NOT (public.has_tenant_role(p_tenant_id, 'reader') OR public.has_tenant_role(p_tenant_id, 'manager')) THEN
    RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _user_id AND p.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'هوية المستخدم لا تتبع المؤسسة';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = p_customer_id AND c.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'المشترك غير موجود أو لا يتبع المؤسسة';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.meters m
    WHERE m.id = p_meter_id AND m.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'العداد غير موجود أو لا يتبع المؤسسة';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.meter_assignments ma
    WHERE ma.tenant_id = p_tenant_id
      AND ma.customer_id = p_customer_id
      AND ma.meter_id = p_meter_id
      AND ma.started_at::date <= p_reading_date
      AND (ma.ended_at IS NULL OR ma.ended_at::date >= p_reading_date)
  ) THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك في تاريخ القراءة';
  END IF;

  IF p_photo_url IS NOT NULL AND btrim(p_photo_url) <> ''
     AND p_photo_url !~ ('^tenants/' || p_tenant_id::text || '/readings/' || p_client_uuid::text || '\\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'مسار صورة الدليل غير صالح لدورة القراءة الحالية';
  END IF;

  SELECT wr.current_reading INTO _previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id
    AND wr.meter_id = p_meter_id
    AND wr.status <> 'rejected'
    AND wr.reading_date <= p_reading_date
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;
  IF _previous IS NOT NULL AND p_current_reading < _previous THEN
    RAISE EXCEPTION 'القراءة الحالية أقل من القراءة السابقة';
  END IF;

  -- Idempotency is strict: the same client_uuid is reusable only for the exact
  -- same logical reading. A conflicting payload is rejected rather than mutating
  -- an already persisted reading or its provenance.
  SELECT * INTO _existing
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id
    AND wr.client_uuid = p_client_uuid
  LIMIT 1;
  IF FOUND THEN
    IF _existing.customer_id IS DISTINCT FROM p_customer_id
       OR _existing.meter_id IS DISTINCT FROM p_meter_id
       OR _existing.current_reading IS DISTINCT FROM p_current_reading
       OR _existing.reading_date IS DISTINCT FROM p_reading_date
       OR _existing.photo_url IS DISTINCT FROM NULLIF(btrim(p_photo_url), '')
       OR upper(coalesce(_existing.reading_source, 'OCR')) IS DISTINCT FROM _source THEN
      RAISE EXCEPTION 'client_uuid مستخدم لقراءة مختلفة؛ تم رفض الطلب لحماية idempotency';
    END IF;
    RETURN _existing.id;
  END IF;

  INSERT INTO public.water_readings (
    tenant_id,
    customer_id,
    meter_id,
    current_reading,
    reading_date,
    client_uuid,
    reader_id,
    photo_url,
    lat,
    lng,
    gps_verified,
    reading_source,
    attempt_count,
    failure_reason,
    verified_at
  ) VALUES (
    p_tenant_id,
    p_customer_id,
    p_meter_id,
    p_current_reading,
    p_reading_date,
    p_client_uuid,
    _user_id,
    NULLIF(btrim(p_photo_url), ''),
    p_lat,
    p_lng,
    COALESCE(p_gps_verified, false),
    _source,
    p_attempt_count,
    NULLIF(btrim(coalesce(p_failure_reason, '')), ''),
    CASE WHEN _source = 'OCR' THEN now() ELSE NULL END
  )
  RETURNING id INTO _reading_id;

  RETURN _reading_id;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO _existing
    FROM public.water_readings wr
    WHERE wr.tenant_id = p_tenant_id
      AND wr.client_uuid = p_client_uuid
    LIMIT 1;
    IF FOUND THEN
      IF _existing.customer_id IS DISTINCT FROM p_customer_id
         OR _existing.meter_id IS DISTINCT FROM p_meter_id
         OR _existing.current_reading IS DISTINCT FROM p_current_reading
         OR _existing.reading_date IS DISTINCT FROM p_reading_date
         OR _existing.photo_url IS DISTINCT FROM NULLIF(btrim(p_photo_url), '')
         OR upper(coalesce(_existing.reading_source, 'OCR')) IS DISTINCT FROM _source THEN
        RAISE EXCEPTION 'client_uuid مستخدم لقراءة مختلفة؛ تم رفض الطلب لحماية idempotency';
      END IF;
      RETURN _existing.id;
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_meter_reading_with_provenance(
  uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean,text,integer,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_meter_reading_with_provenance(
  uuid,uuid,uuid,numeric,date,text,text,numeric,numeric,boolean,text,integer,text
) TO authenticated;

COMMIT;
