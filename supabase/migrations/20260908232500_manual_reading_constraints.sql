-- MIZAN: align reading_source / attempt_count constraints with the first-class MANUAL path.
-- MANUAL is valid without a photo; MANUAL_FALLBACK remains legacy and server-gated.

BEGIN;

ALTER TABLE public.water_readings
  DROP CONSTRAINT IF EXISTS water_readings_reading_source_check;
ALTER TABLE public.water_readings
  ADD CONSTRAINT water_readings_reading_source_check
  CHECK (reading_source IN ('OCR', 'MANUAL', 'MANUAL_FALLBACK'));

ALTER TABLE public.water_readings
  DROP CONSTRAINT IF EXISTS water_readings_attempt_count_check;
ALTER TABLE public.water_readings
  ADD CONSTRAINT water_readings_attempt_count_check
  CHECK (attempt_count >= 0);

COMMIT;
