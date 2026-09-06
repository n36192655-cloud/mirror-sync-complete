-- MIZAN: corrective migration for verified production dependency gaps.
-- 1) Install the historical tariff engine required by issue_bill_for_reading.
-- 2) Align the authoritative reading trigger with the actual water_readings schema.
-- No historical rows are rewritten.

BEGIN;

CREATE OR REPLACE FUNCTION public.price_consumption_historical(
  _tenant_id UUID, _consumption NUMERIC, _reading_date DATE
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  _remaining NUMERIC(18,3) := GREATEST(COALESCE(_consumption,0),0);
  _total NUMERIC(18,3) := 0;
  _prev_upper NUMERIC(18,3) := 0;
  _rate NUMERIC(18,3);
  _upper NUMERIC(18,3);
  _fixed NUMERIC(18,3) := 0;
  _version JSONB;
  _tariff_id UUID;
  _version_id UUID;
  _used_version BOOLEAN := FALSE;
  _slab NUMERIC(18,3);
  _idx INTEGER;
BEGIN
  IF _tenant_id IS NULL OR _remaining <= 0 THEN RETURN 0.000; END IF;

  SELECT tv.id, tv.tariff_id, tv.rate_structure
    INTO _version_id, _tariff_id, _version
  FROM public.tariff_versions tv
  WHERE tv.tenant_id = _tenant_id
    AND _reading_date >= tv.effective_from
    AND (tv.effective_to IS NULL OR _reading_date <= tv.effective_to)
  ORDER BY tv.effective_from DESC
  LIMIT 1;

  IF _version IS NOT NULL THEN
    _used_version := TRUE;
    IF jsonb_typeof(_version) = 'object' THEN
      _fixed := COALESCE(NULLIF(_version->>'fixed_fee','')::NUMERIC,0);
      _version := COALESCE(_version->'tiers','[]'::jsonb);
    END IF;
    IF jsonb_typeof(_version) = 'array' AND jsonb_array_length(_version) > 0 THEN
      FOR _idx IN 0 .. jsonb_array_length(_version)-1 LOOP
        _rate := COALESCE(
          NULLIF((_version->(_idx)->>'rate_per_m3'),'')::NUMERIC,
          NULLIF((_version->(_idx)->>'rate'),'')::NUMERIC, 0);
        _upper := NULLIF(COALESCE(_version->(_idx)->>'upper_bound', _version->(_idx)->>'to'),'')::NUMERIC;
        IF _upper IS NULL THEN
          _total := _total + _remaining * GREATEST(_rate,0);
          _remaining := 0;
        ELSE
          _slab := GREATEST(LEAST(_remaining, _upper - _prev_upper),0);
          _total := _total + _slab * GREATEST(_rate,0);
          _remaining := _remaining - _slab;
          _prev_upper := _upper;
        END IF;
        IF _remaining <= 0 THEN EXIT; END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT _used_version THEN
    SELECT t.id, COALESCE(t.fixed_fee,0)
      INTO _tariff_id, _fixed
    FROM public.tariffs t
    WHERE t.tenant_id = _tenant_id AND t.is_active = TRUE
    ORDER BY t.created_at DESC LIMIT 1;
    IF _tariff_id IS NOT NULL THEN
      FOR _rate, _upper IN
        SELECT tt.rate_per_m3, tt.upper_bound
        FROM public.tariff_tiers tt
        WHERE tt.tenant_id = _tenant_id AND tt.tariff_id = _tariff_id
        ORDER BY tt.tier_order ASC
      LOOP
        IF _remaining <= 0 THEN EXIT; END IF;
        IF _upper IS NULL THEN
          _total := _total + _remaining * GREATEST(_rate,0);
          _remaining := 0;
        ELSE
          _slab := GREATEST(LEAST(_remaining, _upper - _prev_upper),0);
          _total := _total + _slab * GREATEST(_rate,0);
          _remaining := _remaining - _slab;
          _prev_upper := _upper;
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN ROUND(_total + _fixed,3);
END;
$$;

REVOKE ALL ON FUNCTION public.price_consumption_historical(UUID,NUMERIC,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.price_consumption_historical(UUID,NUMERIC,DATE) TO authenticated, service_role;

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

  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: المؤسسة والمشترك والعداد مطلوبة';
  END IF;
  IF NEW.client_uuid IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: client_uuid مطلوب';
  END IF;
  IF NEW.photo_url IS NULL OR btrim(NEW.photo_url) = '' THEN
    RAISE EXCEPTION 'لا يمكن حفظ قراءة عداد بدون صورة أصلية موثقة';
  END IF;
  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;

  _tenant := public.current_tenant_id();
  IF NEW.tenant_id <> _tenant AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
  END IF;
  IF NOT (
    public.has_tenant_role(NEW.tenant_id, 'reader')
    OR public.has_tenant_role(NEW.tenant_id, 'manager')
  ) THEN
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
  ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد في تاريخ القراءة';
  END IF;

  IF NEW.photo_url !~ (
    '^tenants/' || NEW.tenant_id::text || '/readings/' ||
    NEW.client_uuid::text || '\.(jpg|png|webp)$'
  ) THEN
    RAISE EXCEPTION 'صورة الدليل غير مرتبطة بدورة القراءة الحالية';
  END IF;

  NEW.tenant_id := _meter.tenant_id;
  PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

  SELECT wr.current_reading INTO _previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = NEW.tenant_id
    AND wr.meter_id = NEW.meter_id
    AND wr.status = 'approved'
    AND wr.reading_date <= COALESCE(NEW.reading_date, CURRENT_DATE)
    AND (NEW.id IS NULL OR wr.id <> NEW.id)
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;

  SELECT m.initial_index INTO _initial
  FROM public.meters m WHERE m.id = NEW.meter_id;

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

DROP TRIGGER IF EXISTS tg_reading_before_insert ON public.water_readings;
DROP TRIGGER IF EXISTS trg_meter_reading_pipeline_before_insert ON public.water_readings;
CREATE TRIGGER trg_meter_reading_pipeline_before_insert
BEFORE INSERT ON public.water_readings
FOR EACH ROW EXECUTE FUNCTION public.tg_meter_reading_pipeline_before_insert();

REVOKE ALL ON FUNCTION public.tg_meter_reading_pipeline_before_insert() FROM PUBLIC;

COMMIT;
