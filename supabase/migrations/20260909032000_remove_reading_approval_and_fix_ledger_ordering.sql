-- MIZAN: readings are recorded/processed without administrative approval.
-- Administrative approval is reserved for collection/payment workflows.
-- Also repair the production ledger running-balance helper: customer_ledger does
-- not have created_at, so ordering uses the actual posted_at column + id.

BEGIN;

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
  _is_service_role BOOLEAN :=
    COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    OR current_user = 'service_role';
BEGIN
  IF NOT _is_service_role THEN
    PERFORM public.assert_authenticated_context();
  END IF;

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

  IF _is_service_role THEN
    IF NEW.reader_id IS NULL THEN
      RAISE EXCEPTION 'قراءة غير صالحة: هوية قارئ القراءة مطلوبة';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.reader_id AND p.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'هوية قارئ القراءة لا تتبع المؤسسة';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = NEW.reader_id
        AND ur.tenant_id = NEW.tenant_id
        AND ur.role IN ('reader','manager')
    ) THEN
      RAISE EXCEPTION 'مستخدم القراءة غير مخول لتسجيل قراءة';
    END IF;
  ELSE
    IF NEW.tenant_id <> _tenant AND NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'المؤسسة الحالية لا تطابق القراءة';
    END IF;
    IF NOT (
      public.has_tenant_role(NEW.tenant_id, 'reader')
      OR public.has_tenant_role(NEW.tenant_id, 'manager')
    ) THEN
      RAISE EXCEPTION 'المستخدم غير مخول لتسجيل قراءة';
    END IF;
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
    AND started_at::date <= COALESCE(NEW.reading_date, public.mizan_business_date())
    AND (ended_at IS NULL OR ended_at::date >= COALESCE(NEW.reading_date, public.mizan_business_date()))
  ORDER BY started_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العداد غير مرتبط بالمشترك المحدد في تاريخ القراءة';
  END IF;

  IF NEW.photo_url IS NOT NULL AND btrim(NEW.photo_url) <> ''
     AND NEW.photo_url !~ ('^tenants/' || NEW.tenant_id::text || '/readings/' || NEW.client_uuid::text || '\\.(jpg|png|webp)$')
  THEN
    RAISE EXCEPTION 'صورة الدليل غير مرتبطة بدورة القراءة الحالية';
  END IF;

  NEW.tenant_id := _meter.tenant_id;
  PERFORM public.acquire_customer_lock(NEW.tenant_id, NEW.customer_id);

  SELECT wr.current_reading INTO _previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = NEW.tenant_id
    AND wr.meter_id = NEW.meter_id
    AND wr.status = 'approved'
    AND wr.reading_date <= COALESCE(NEW.reading_date, public.mizan_business_date())
    AND (NEW.id IS NULL OR wr.id <> NEW.id)
  ORDER BY wr.reading_date DESC, wr.created_at DESC
  LIMIT 1;

  SELECT m.initial_index INTO _initial
  FROM public.meters m
  WHERE m.id = NEW.meter_id;

  NEW.previous := COALESCE(_previous, _initial, 0);
  IF NEW.current_reading < NEW.previous THEN
    RAISE EXCEPTION 'القراءة الحالية أقل من القراءة السابقة';
  END IF;
  NEW.consumption := NEW.current_reading - NEW.previous;

  SELECT AVG(consumption) INTO _average
  FROM public.water_readings
  WHERE tenant_id = NEW.tenant_id
    AND meter_id = NEW.meter_id
    AND status = 'approved';

  IF _average IS NOT NULL AND NEW.consumption > (_average * 3) THEN
    NEW.flag := 'suspicious';
  ELSE
    NEW.flag := COALESCE(NEW.flag, 'ok');
  END IF;

  NEW.status := 'approved';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_meter_reading_pipeline_before_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rebuild_customer_ledger_running_balance(
  _tenant_id UUID,
  _customer_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF _tenant_id IS NULL OR _customer_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM public.acquire_customer_lock(_tenant_id, _customer_id);

  WITH ordered AS (
    SELECT
      l.id,
      ROUND(
        SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) OVER (
          PARTITION BY l.tenant_id, l.customer_id
          ORDER BY COALESCE(l.posted_at, 'epoch'::timestamptz), l.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        3
      ) AS expected_running_balance
    FROM public.customer_ledger l
    WHERE l.tenant_id = _tenant_id
      AND l.customer_id = _customer_id
  )
  UPDATE public.customer_ledger l
  SET running_balance = ordered.expected_running_balance
  FROM ordered
  WHERE l.id = ordered.id
    AND l.running_balance IS DISTINCT FROM ordered.expected_running_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rebuild_customer_ledger_running_balance(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_customer_ledger_rebuild_running_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.rebuild_customer_ledger_running_balance(NEW.tenant_id, NEW.customer_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_ledger_rebuild_running_balance ON public.customer_ledger;
CREATE TRIGGER trg_customer_ledger_rebuild_running_balance
AFTER INSERT ON public.customer_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_customer_ledger_rebuild_running_balance();

DO $$
BEGIN
  IF to_regprocedure('public.approve_reading(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.approve_reading(uuid) FROM PUBLIC, anon, authenticated;
  END IF;
  IF to_regprocedure('public.reject_reading(uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.reject_reading(uuid,text) FROM PUBLIC, anon, authenticated;
  END IF;
END;
$$;

COMMIT;
