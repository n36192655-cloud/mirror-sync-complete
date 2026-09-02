-- MIZAN: secure meter-reading image storage
-- Aligns the original storage migration with the current tenant model and
-- the application path: tenants/{tenant_id}/readings/{client_id}.{ext}

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'meter-readings',
  'meter-readings',
  false,
  26214400, -- 25 MiB: preserve high-quality camera originals; no client compression
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

CREATE OR REPLACE FUNCTION storage.meter_reading_path_tenant_id(storage_path text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parts text[];
  tenant_uuid uuid;
BEGIN
  parts := string_to_array(storage_path, '/');
  IF array_length(parts, 1) <> 4 OR parts[1] <> 'tenants' OR parts[3] <> 'readings' THEN
    RETURN NULL;
  END IF;
  BEGIN
    tenant_uuid := parts[2]::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF parts[4] !~ '^[0-9a-fA-F-]{36}\.(jpg|png|webp)$' THEN
    RETURN NULL;
  END IF;
  RETURN tenant_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION storage.meter_reading_same_tenant(storage_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT storage.meter_reading_path_tenant_id(storage_path) = (
    SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid()
  );
$$;

DROP POLICY IF EXISTS "Meter readings storage upload policy" ON storage.objects;
DROP POLICY IF EXISTS "Meter readings storage read policy" ON storage.objects;
DROP POLICY IF EXISTS "Meter readings storage update policy" ON storage.objects;
DROP POLICY IF EXISTS "Meter readings storage delete policy" ON storage.objects;
DROP POLICY IF EXISTS "meter_readings_insert" ON storage.objects;
DROP POLICY IF EXISTS "meter_readings_select" ON storage.objects;
DROP POLICY IF EXISTS "meter_readings_update" ON storage.objects;
DROP POLICY IF EXISTS "meter_readings_delete" ON storage.objects;

CREATE POLICY "meter_readings_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'meter-readings'
  AND storage.meter_reading_same_tenant(name)
  AND (
    public.has_tenant_role(storage.meter_reading_path_tenant_id(name), 'reader')
    OR public.has_tenant_role(storage.meter_reading_path_tenant_id(name), 'manager')
  )
);

CREATE POLICY "meter_readings_select"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND storage.meter_reading_same_tenant(name)
);

CREATE POLICY "meter_readings_update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND storage.meter_reading_same_tenant(name)
  AND public.has_tenant_role(storage.meter_reading_path_tenant_id(name), 'manager')
)
WITH CHECK (
  bucket_id = 'meter-readings'
  AND storage.meter_reading_same_tenant(name)
  AND public.has_tenant_role(storage.meter_reading_path_tenant_id(name), 'manager')
);

CREATE POLICY "meter_readings_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND storage.meter_reading_same_tenant(name)
  AND public.has_tenant_role(storage.meter_reading_path_tenant_id(name), 'manager')
);

REVOKE ALL ON FUNCTION storage.meter_reading_path_tenant_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storage.meter_reading_path_tenant_id(text) TO authenticated;
REVOKE ALL ON FUNCTION storage.meter_reading_same_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storage.meter_reading_same_tenant(text) TO authenticated;
