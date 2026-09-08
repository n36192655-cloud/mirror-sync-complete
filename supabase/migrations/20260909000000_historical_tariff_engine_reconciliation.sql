-- MIZAN: make historical tariff pricing actually use tariff_versions.rate_structure.
-- Safe for existing installations: falls back to the legacy active tariff when no
-- applicable historical version exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.price_consumption_historical(
  _tenant_id UUID,
  _consumption NUMERIC,
  _pricing_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_consumption NUMERIC := GREATEST(COALESCE(_consumption, 0), 0);
  v_version RECORD;
  v_fixed_fee NUMERIC := 0;
  v_total NUMERIC := 0;
  v_remaining NUMERIC;
  v_previous NUMERIC := 0;
  v_upper NUMERIC;
  v_rate NUMERIC;
  v_slice NUMERIC;
  v_tier JSONB;
BEGIN
  IF _tenant_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT tv.*
  INTO v_version
  FROM public.tariff_versions tv
  WHERE tv.tenant_id = _tenant_id
    AND COALESCE(_pricing_date, CURRENT_DATE) >= tv.effective_from
    AND (tv.effective_to IS NULL OR COALESCE(_pricing_date, CURRENT_DATE) <= tv.effective_to)
  ORDER BY tv.effective_from DESC, tv.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN public.price_consumption(_tenant_id, v_consumption);
  END IF;

  -- Expected version snapshot shape:
  -- { "fixed_fee": 0, "tiers": [
  --   {"upper_bound": 5, "rate_per_m3": 100},
  --   {"upper_bound": 12, "rate_per_m3": 250},
  --   {"upper_bound": null, "rate_per_m3": 500}
  -- ] }
  v_fixed_fee := COALESCE(
    NULLIF(v_version.rate_structure->>'fixed_fee','')::NUMERIC,
    0
  );

  v_remaining := v_consumption;
  v_total := v_fixed_fee;

  IF jsonb_typeof(v_version.rate_structure->'tiers') = 'array' THEN
    FOR v_tier IN
      SELECT value
      FROM jsonb_array_elements(v_version.rate_structure->'tiers')
    LOOP
      EXIT WHEN v_remaining <= 0;

      v_upper := CASE
        WHEN NULLIF(v_tier->>'upper_bound','') IS NULL THEN NULL
        ELSE (v_tier->>'upper_bound')::NUMERIC
      END;

      v_rate := COALESCE(
        NULLIF(v_tier->>'rate_per_m3','')::NUMERIC,
        NULLIF(v_tier->>'rate','')::NUMERIC,
        0
      );

      v_slice := CASE
        WHEN v_upper IS NULL THEN v_remaining
        ELSE LEAST(v_remaining, GREATEST(v_upper - v_previous, 0))
      END;

      v_total := v_total + (v_slice * v_rate);
      v_remaining := v_remaining - v_slice;

      IF v_upper IS NOT NULL THEN
        v_previous := v_upper;
      END IF;
    END LOOP;

    -- A malformed/empty snapshot must not silently underprice consumption.
    IF v_remaining <= 0 THEN
      RETURN ROUND(v_total, 3);
    END IF;
  END IF;

  -- Compatibility fallback for old version rows whose JSON snapshot is absent.
  RETURN public.price_consumption(_tenant_id, v_consumption);
END;
$$;

-- Verification helper: exposes the effective historical version and calculated price.
CREATE OR REPLACE FUNCTION public.verify_historical_tariff_pricing(
  _tenant_id UUID,
  _pricing_date DATE,
  _consumption NUMERIC
)
RETURNS TABLE (
  tariff_version_id UUID,
  effective_from DATE,
  effective_to DATE,
  calculated_amount NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    tv.id,
    tv.effective_from,
    tv.effective_to,
    public.price_consumption_historical(
      _tenant_id,
      _consumption,
      _pricing_date
    )
  FROM public.tariff_versions tv
  WHERE tv.tenant_id = _tenant_id
    AND _pricing_date >= tv.effective_from
    AND (tv.effective_to IS NULL OR _pricing_date <= tv.effective_to)
  ORDER BY tv.effective_from DESC
  LIMIT 1;
$$;

COMMIT;
