-- Migration 023: Normalize existing comp.county values to canonical form.
--
-- Background: the AI extraction pipeline was producing inconsistent county
-- values across imports:
--   "Frio County" / "Frio" / "frio county" / "FRIO" / "Frio and Medina" /
--   "Atascosa & Frio" / "Atascosa, Wilson" / " frio "
-- This silently broke county-based filtering and made the data hard to
-- reason about. From this migration onward, all writes go through the
-- JS normalizer in src/lib/utils/normalizeCounty.ts — this migration
-- backfills the existing rows so the whole table is consistent.
--
-- Canonical form rules:
--   - Titlecase: "Frio" not "FRIO" not "frio"
--   - No "County" suffix
--   - Compound counties joined by ", " — single comma + space
--   - Whitespace collapsed and trimmed
--   - Duplicate counties within a compound deduped
--
-- Examples after this migration:
--   "Frio County"        → "Frio"
--   "frio"               → "Frio"
--   "Frio and Medina"    → "Frio, Medina"
--   "Atascosa & Frio"    → "Atascosa, Frio"
--   "Atascosa, Wilson"   → "Atascosa, Wilson"
--   ""                   → "" (unchanged — keep empty strings empty)
--
-- The map page still uses suffix-tolerant matching at READ time
-- (splitCounties helper) as defense-in-depth, so this migration won't
-- break anything if a non-canonical value slips in later.

-- ─────────────────────────────────────────────────────────────────────
-- One-time helper function — created, used, dropped within this
-- migration so it doesn't pollute the schema. Lives in plpgsql so we
-- can do the splitting / titlecasing / dedup in one place.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.normalize_county_storage(raw text)
RETURNS text AS $$
DECLARE
  pieces text[];
  piece text;
  word text;
  titlecased text;
  result text[];
BEGIN
  IF raw IS NULL OR length(btrim(raw)) = 0 THEN
    RETURN raw; -- keep null as null, empty as empty
  END IF;

  -- Split on " and " / " & " / "," / "/" (case-insensitive on "and")
  pieces := regexp_split_to_array(raw, '(?i)\s+and\s+|\s*&\s*|\s*,\s*|\s*/\s*');
  result := ARRAY[]::text[];

  FOREACH piece IN ARRAY pieces LOOP
    -- Lowercase, strip "county" word, collapse whitespace, trim
    piece := lower(piece);
    piece := regexp_replace(piece, '\bcounty\b', '', 'g');
    piece := regexp_replace(piece, '\s+', ' ', 'g');
    piece := btrim(piece);
    CONTINUE WHEN length(piece) = 0;

    -- Titlecase each word
    titlecased := '';
    FOREACH word IN ARRAY string_to_array(piece, ' ') LOOP
      IF length(word) > 0 THEN
        IF length(titlecased) > 0 THEN
          titlecased := titlecased || ' ';
        END IF;
        titlecased := titlecased || upper(substring(word, 1, 1)) || substring(word, 2);
      END IF;
    END LOOP;

    -- Dedupe within this compound (skip if already present)
    IF NOT (titlecased = ANY(result)) THEN
      result := result || titlecased;
    END IF;
  END LOOP;

  IF array_length(result, 1) IS NULL THEN
    RETURN '';
  END IF;
  RETURN array_to_string(result, ', ');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill. Only update rows where the normalized form differs from
-- what's stored — saves a no-op write on every row.
-- ─────────────────────────────────────────────────────────────────────
UPDATE comps
SET county = pg_temp.normalize_county_storage(county)
WHERE county IS NOT NULL
  AND county IS DISTINCT FROM pg_temp.normalize_county_storage(county);

-- pg_temp functions are auto-dropped at session end, but be explicit.
DROP FUNCTION IF EXISTS pg_temp.normalize_county_storage(text);

NOTIFY pgrst, 'reload schema';
