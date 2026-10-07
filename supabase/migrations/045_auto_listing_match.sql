-- Auto listing matching (2026-10-07).
--
-- Broker decision: comps should get their public listing link
-- automatically, without clicking "Find listing online".
--   * HIGH-confidence matches (strict 3-identifier checklist, or the
--     own-site name+county+acreage rule) write source_url directly.
--   * MEDIUM-confidence matches (strong but short of certain) land in
--     suggested_listing_url for an agent to confirm or dismiss from
--     the comp detail panel — they never silently become the source
--     of record.
--   * listing_match_confidence records which path set the link
--     ('high_auto' | 'medium_suggested' | 'manual') so we can audit
--     the auto-matcher's hit rate later.
--   * listing_match_reason keeps the model's one-line justification —
--     shown next to the suggestion so the agent knows WHY it matched.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS suggested_listing_url TEXT,
  ADD COLUMN IF NOT EXISTS listing_match_confidence TEXT,
  ADD COLUMN IF NOT EXISTS listing_match_reason TEXT;

COMMENT ON COLUMN comps.suggested_listing_url IS
  'Medium-confidence auto-match awaiting agent confirm/dismiss. Never used as source of record until accepted.';
COMMENT ON COLUMN comps.listing_match_confidence IS
  'high_auto | medium_suggested | manual — provenance of source_url / suggested_listing_url.';
COMMENT ON COLUMN comps.listing_match_reason IS
  'Model''s one-line match justification, shown beside the suggestion.';
