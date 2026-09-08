-- MIZAN PART 3: authoritative meter-display/precision profile.
-- Nullable by design: existing meters keep their current behavior until explicitly configured.
-- No financial tables/functions are changed by this migration.

BEGIN;

ALTER TABLE public.meters
  ADD COLUMN IF NOT EXISTS display_type TEXT,
  ADD COLUMN IF NOT EXISTS integer_digits SMALLINT,
  ADD COLUMN IF NOT EXISTS decimal_digits SMALLINT,
  ADD COLUMN IF NOT EXISTS decimal_separator TEXT,
  ADD COLUMN IF NOT EXISTS register_semantics JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meters_display_type_valid'
      AND conrelid = 'public.meters'::regclass
  ) THEN
    ALTER TABLE public.meters
      ADD CONSTRAINT meters_display_type_valid
      CHECK (
        display_type IS NULL OR display_type IN (
          'mechanical_roller',
          'black_red_register',
          'white_red_register',
          'multi_register',
          'analog_dial',
          'digital_lcd',
          'digital_led',
          'smart_display',
          'unknown'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meters_integer_digits_valid'
      AND conrelid = 'public.meters'::regclass
  ) THEN
    ALTER TABLE public.meters
      ADD CONSTRAINT meters_integer_digits_valid
      CHECK (integer_digits IS NULL OR integer_digits BETWEEN 1 AND 12);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meters_decimal_digits_valid'
      AND conrelid = 'public.meters'::regclass
  ) THEN
    ALTER TABLE public.meters
      ADD CONSTRAINT meters_decimal_digits_valid
      CHECK (decimal_digits IS NULL OR decimal_digits BETWEEN 0 AND 12);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meters_decimal_separator_valid'
      AND conrelid = 'public.meters'::regclass
  ) THEN
    ALTER TABLE public.meters
      ADD CONSTRAINT meters_decimal_separator_valid
      CHECK (decimal_separator IS NULL OR decimal_separator IN ('.', ','));
  END IF;
END $$;

COMMIT;
