-- MIZAN: remove the production dependency on SUPABASE_SERVICE_ROLE_KEY
-- from the meter-reading save path.
--
-- The browser/server session remains the authorization boundary. The RPC is
-- SECURITY DEFINER only because direct INSERT on water_readings is intentionally
-- revoked from authenticated/anon. All authorization and integrity checks are
-- performed from the caller's authenticated identity before the INSERT.

BEGIN;

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
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _reading_id uuid;
  _tenant_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مصادق عليه';
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

  IF p_photo_url IS NULL OR btrim(p_photo_url) = '' THEN
    RAISE EXCEPTION 'صورة الدليل مطلوبة';
  END IF;

  _tenant_id := public.current_tenant_id();
  IF _tenant_id IS NULL OR _tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
  END IF;

  IF NOT (
    public.has_tenant_role(p_tenant_id, 'reader')
    OR public.has_tenant_role(p_tenant_id, 'manager')
  ) THEN
    RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = _user_id
      AND p.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'هوية المستخدم لا تتبع المؤسسة';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.id = p_customer_id
      AND c.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'المشترك غير موجود أو لا يتبع المؤسسة';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.meters m
    WHERE m.id = p_meter_id
      AND m.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'العداد غير موجود أو لا يتبع المؤسسة';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.meter_assignments ma
    WHERE ma.tenant_id = p_tenant_id
      AND ma.customer_id = p_customer_id
      AND ma.meter_id = p_meter_id
      AND ma.started_at::date <= p_reading_date
      AND (ma.ended_at IS NULL OR ma.ended_at::date >= p_reading_date)
  ) THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك في تاريخ القراءة';
  END IF;

  IF p_photo_url !~ ('^tenants/' || p_tenant_id::text || '/readings/' || p_client_uuid::text || '\\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'مسار صورة الدليل غير صالح لدورة القراءة الحالية';
  END IF;

  -- Idempotency is enforced by the existing unique client_uuid boundary.
  -- A duplicate returns the existing row rather than creating a second reading.
  SELECT wr.id INTO _reading_id
  FROM public.water_readings wr
  WHERE wr.tenant_id = p_tenant_id
    AND wr.client_uuid = p_client_uuid
  LIMIT 1;

  IF _reading_id IS NOT NULL THEN
    RETURN _reading_id;
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
    gps_verified
  ) VALUES (
    p_tenant_id,
    p_customer_id,
    p_meter_id,
    p_current_reading,
    p_reading_date,
    p_client_uuid,
    _user_id,
    p_photo_url,
    p_lat,
    p_lng,
    COALESCE(p_gps_verified, false)
  )
  RETURNING id INTO _reading_id;

  RETURN _reading_id;
EXCEPTION
  WHEN unique_violation THEN
    SELECT wr.id INTO _reading_id
    FROM public.water_readings wr
    WHERE wr.tenant_id = p_tenant_id
      AND wr.client_uuid = p_client_uuid
    LIMIT 1;
    IF _reading_id IS NOT NULL THEN
      RETURN _reading_id;
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_verified_meter_reading(
  uuid, uuid, uuid, numeric, date, text, text, numeric, numeric, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_verified_meter_reading(
  uuid, uuid, uuid, numeric, date, text, text, numeric, numeric, boolean
) TO authenticated;

COMMENT ON FUNCTION public.insert_verified_meter_reading(
  uuid, uuid, uuid, numeric, date, text, text, numeric, numeric, boolean
) IS 'Authenticated, tenant-scoped meter-reading persistence boundary. Direct water_readings INSERT remains revoked from browser roles.';

COMMIT;
