-- Migration 031: Opinion of Value presentation modes + Valuation Notes
--
-- Background: a hard Opinion of Value works when the broker has high
-- confidence and the client has already had a conversation. It works
-- poorly when:
--   - the seller is emotionally attached (family land, estate, divorce)
--   - the property is unique with no clean comps
--   - the broker is still pre-listing and wants to gather info before
--     committing a number
--   - the deal has structural complexity (mineral rights, easements,
--     partial sale) that warrants discussion
--
-- Two new columns let the broker control how the Opinion of Value
-- LANDS for the client, separate from the underlying values they
-- entered:
--
--   opinion_presentation TEXT NULL  — display mode for the report:
--     'confirmed' (default): show the hard number ($X.XM)
--     'range'              : show "$Low–$High range" only, no point
--                            estimate. Derived from comp range × subj
--                            acres on render; no new low/high columns.
--     'discuss'            : show "Opinion of Value: Let's discuss"
--                            with comp data + CTA, no hard number.
--                            The seller arrives at the meeting with
--                            comp evidence but no anchor to react to.
--     NULL                 : same as 'confirmed' (backwards-compat
--                            for CMAs created before this migration).
--
--   valuation_notes TEXT NULL  — broker's free-text WHY paragraph that
--     appears below the Opinion of Value. Especially useful in
--     'discuss' or 'range' modes, OR when the broker's hard BOV sits
--     outside the comp range (above/below indicator was shipped in
--     PR #43). Lets the broker write 1-2 sentences explaining where
--     the subject fits and why.
--
-- Why two columns instead of one: presentation mode and notes are
-- independently meaningful. A broker can ship in 'confirmed' mode
-- with a note ("$6.75M reflects the hacienda + dual creek frontage")
-- or in 'discuss' mode without one. The notes column also outlives
-- the presentation toggle — if we later add other modes or remove
-- 'discuss', the notes still make sense as a generic broker-written
-- explanation.
--
-- broker_opinion_mode (lump_sum | breakdown) is UNTOUCHED. That's the
-- value-entry STYLE — orthogonal to presentation. A broker entering
-- as Land + Improvements can still ship in 'discuss' mode; the
-- entered values get persisted, just hidden on the report.

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS opinion_presentation TEXT NULL,
  ADD COLUMN IF NOT EXISTS valuation_notes TEXT NULL;

-- Constrain presentation to recognized values. NULL permitted
-- (treated as 'confirmed' on the read path).
ALTER TABLE cmas
  DROP CONSTRAINT IF EXISTS cmas_opinion_presentation_check;

ALTER TABLE cmas
  ADD CONSTRAINT cmas_opinion_presentation_check
  CHECK (opinion_presentation IS NULL
      OR opinion_presentation IN ('confirmed', 'range', 'discuss'));

-- Reload PostgREST schema cache so the new columns are immediately
-- visible to API writes — the resilient saveBov retry will catch
-- any miss, but this avoids the toast-spam on first use.
NOTIFY pgrst, 'reload schema';
