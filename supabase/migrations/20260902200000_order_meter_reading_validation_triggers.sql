-- Ensure the security validation runs both before and after the legacy
-- financial trigger. PostgreSQL fires BEFORE triggers in name order.
-- The first pass validates the client-supplied customer/meter relationship;
-- the final pass restores server-authoritative previous/consumption/status
-- after the legacy trigger has finished.

DROP TRIGGER IF EXISTS tg_validate_meter_reading ON public.water_readings;
DROP TRIGGER IF EXISTS a_validate_meter_reading ON public.water_readings;
DROP TRIGGER IF EXISTS z_validate_meter_reading ON public.water_readings;

CREATE TRIGGER a_validate_meter_reading
BEFORE INSERT ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_validate_meter_reading();

CREATE TRIGGER z_validate_meter_reading
BEFORE INSERT ON public.water_readings
FOR EACH ROW
EXECUTE FUNCTION public.tg_validate_meter_reading();
