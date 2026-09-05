-- Harden the verified meter-reading persistence boundary.
-- The application uploads the authenticated image to Storage first, then calls
-- insert_verified_meter_reading(). This trigger prevents a DB row from pointing
-- at an object outside the tenant-scoped meter-readings namespace.

CREATE OR REPLACE FUNCTION public.validate_verified_meter_photo_path()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.photo_url IS NULL OR NEW.photo_url = '' THEN
    RAISE EXCEPTION 'photo_url is required for verified meter readings';
  END IF;

  IF NEW.client_uuid IS NULL OR NEW.client_uuid = '' THEN
    RAISE EXCEPTION 'client_uuid is required for verified meter readings';
  END IF;

  IF NEW.photo_url !~ ('^tenants/' || NEW.tenant_id::text || '/readings/' || NEW.client_uuid || '\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'photo_url does not match tenant-scoped client_uuid path';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_verified_meter_photo_path ON public.water_readings;

CREATE TRIGGER trg_validate_verified_meter_photo_path
BEFORE INSERT OR UPDATE OF tenant_id, client_uuid, photo_url
ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.validate_verified_meter_photo_path();

REVOKE EXECUTE ON FUNCTION public.validate_verified_meter_photo_path() FROM PUBLIC, anon, authenticated;
