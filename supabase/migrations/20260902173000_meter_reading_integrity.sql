-- MIZAN: field meter-reading integrity hardening
-- Goals:
--   * every reading must belong to the customer's active meter assignment
--   * meter_id/customer_id cannot be mixed by a client
--   * meter number is derived from the authoritative meters row
--   * one successful reading per meter per field date
--   * consumption/previous are derived server-side
--   * offline retries remain idempotent through client_uuid

ALTER TABLE public.water_readings
  ADD COLUMN IF NOT EXISTS meter_id UUID;

-- Keep the schema compatible with installations that predate meter_id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'water_readings_meter_fk'
  ) THEN
    ALTER TABLE public.water_readings
      ADD CONSTRAINT water_readings_meter_fk
      FOREIGN KEY (meter_id) REFERENCES public.meters(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Backfill meter_id from the active assignment when possible.
UPDATE public.water_readings r
SET meter_id = a.meter_id
FROM public.meter_assignments a
WHERE r.meter_id IS NULL
  AND a.customer_id = r.customer_id
  AND a.tenant_id = r.tenant_id
  AND a.ended_at IS NULL;

CREATE INDEX IF NOT EXISTS water_readings_tenant_meter_date_idx
  ON public.water_readings (tenant_id, meter_id, reading_date, created_at DESC);

-- A field cycle cannot create two successful readings for the same meter/day.
CREATE UNIQUE INDEX IF NOT EXISTS water_readings_one_per_meter_day_uidx
  ON public.water_readings (tenant_id, meter_id, reading_date)
  WHERE meter_id IS NOT NULL AND status <> 'rejected';

CREATE UNIQUE INDEX IF NOT EXISTS water_readings_client_uuid_uidx
  ON public.water_readings (tenant_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_validate_meter_reading()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _meter public.meters%ROWTYPE;
  _assignment public.meter_assignments%ROWTYPE;
  _prev NUMERIC;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.customer_id IS NULL OR NEW.meter_id IS NULL THEN
    RAISE EXCEPTION 'قراءة غير صالحة: المشترك والعداد والمؤسسة مطلوبة';
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
    AND ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد';
  END IF;

  -- Never trust a meter number supplied by the client.
  NEW.meter_number := _meter.serial;

  SELECT wr.current_reading INTO _prev
  FROM public.water_readings wr
  WHERE wr.tenant_id = NEW.tenant_id
    AND wr.meter_id = NEW.meter_id
    AND wr.status <> 'rejected'
    AND wr.reading_date <= COALESCE(NEW.reading_date, CURRENT_DATE)
    AND (NEW.id IS NULL OR wr.id <> NEW.id)
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;

  NEW.previous := COALESCE(_prev, 0);

  IF NEW.current_reading IS NULL OR NEW.current_reading < 0 THEN
    RAISE EXCEPTION 'القراءة الحالية غير صالحة';
  END IF;

  IF NEW.current_reading < NEW.previous THEN
    NEW.consumption := 0;
    NEW.flag := 'error';
    NEW.status := 'pending_approval';
  ELSE
    NEW.consumption := NEW.current_reading - NEW.previous;
    NEW.flag := COALESCE(NEW.flag, 'ok');
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_validate_meter_reading ON public.water_readings;
CREATE TRIGGER trg_validate_meter_reading
BEFORE INSERT ON public.water_readings
FOR EACH ROW EXECUTE FUNCTION public.tg_validate_meter_reading();

-- Reader may create a reading only for the currently assigned meter.
DROP POLICY IF EXISTS "reader manager insert readings" ON public.water_readings;
CREATE POLICY "reader manager insert readings" ON public.water_readings
FOR INSERT TO authenticated
WITH CHECK (
  tenant_id = public.current_tenant_id()
  AND (
    public.has_tenant_role(tenant_id, 'manager')
    OR (
      public.has_tenant_role(tenant_id, 'reader')
      AND EXISTS (
        SELECT 1
        FROM public.meter_assignments ma
        WHERE ma.tenant_id = water_readings.tenant_id
          AND ma.customer_id = water_readings.customer_id
          AND ma.meter_id = water_readings.meter_id
          AND ma.ended_at IS NULL
      )
    )
  )
);

COMMENT ON COLUMN public.water_readings.meter_id IS
  'Authoritative meter identity. Must be the active meter assigned to customer_id; never trust a client-supplied serial.';
