-- MIZAN: OCR attempt provenance and audited manual fallback.
-- Non-destructive extension of the verified meter-reading boundary.

BEGIN;

ALTER TABLE public.water_readings
  ADD COLUMN IF NOT EXISTS reading_source text NOT NULL DEFAULT 'OCR',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE public.water_readings
  DROP CONSTRAINT IF EXISTS water_readings_reading_source_check;
ALTER TABLE public.water_readings
  ADD CONSTRAINT water_readings_reading_source_check
  CHECK (reading_source IN ('OCR', 'MANUAL_FALLBACK'));

ALTER TABLE public.water_readings
  DROP CONSTRAINT IF EXISTS water_readings_attempt_count_check;
ALTER TABLE public.water_readings
  ADD CONSTRAINT water_readings_attempt_count_check
  CHECK (attempt_count BETWEEN 1 AND 3);

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
  _reading_id uuid;
  _source text := upper(coalesce(p_reading_source, ''));
  _previous numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مصادق عليه';
  END IF;

  IF _source NOT IN ('OCR', 'MANUAL_FALLBACK') THEN
    RAISE EXCEPTION 'مصدر القراءة غير صالح';
  END IF;

  IF p_attempt_count IS NULL OR p_attempt_count < 1 OR p_attempt_count > 3 THEN
    RAISE EXCEPTION 'عدد محاولات OCR غير صالح';
  END IF;

  IF _source = 'MANUAL_FALLBACK' AND p_attempt_count <> 3 THEN
    RAISE EXCEPTION 'الإدخال اليدوي مسموح فقط بعد ثلاث محاولات OCR فاشلة';
  END IF;

  IF _source = 'MANUAL_FALLBACK' AND nullif(btrim(coalesce(p_failure_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'سبب فشل OCR مطلوب للإدخال اليدوي';
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

  _reading_id := public.insert_verified_meter_reading(
    p_tenant_id, p_customer_id, p_meter_id, p_current_reading, p_reading_date,
    p_client_uuid, p_photo_url, p_lat, p_lng, p_gps_verified
  );

  UPDATE public.water_readings
  SET reading_source = _source,
      attempt_count = p_attempt_count,
      failure_reason = nullif(btrim(coalesce(p_failure_reason, '')), ''),
      verified_at = CASE WHEN _source = 'OCR' THEN now() ELSE NULL END
  WHERE id = _reading_id
    AND tenant_id = p_tenant_id;

  RETURN _reading_id;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_meter_reading_with_provenance(
  uuid, uuid, uuid, numeric, date, text, text, numeric, numeric, boolean, text, integer, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.insert_meter_reading_with_provenance(
  uuid, uuid, uuid, numeric, date, text, text, numeric, numeric, boolean, text, integer, text
) TO authenticated;

COMMIT;
