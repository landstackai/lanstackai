-- Migration 037: comp_documents — source-document provenance for extracted comps.
--
-- Phase 2c of the PDF import rebuild. Background:
--
-- Today every imported comp is a free-floating record in the vault — once
-- the broker closes the import session, there's no link back to the PDF
-- the comp was extracted from. If the broker (or anyone reviewing the
-- CMA) wants to verify "did the AI read this right?" they have to dig
-- through their email or local Downloads folder for the original file.
-- Half the time it's gone.
--
-- This table changes that. Every import session uploads the source PDF
-- to storage ONCE and records one comp_documents row PER COMP that came
-- out of that PDF (multiple comps can share a single source_path —
-- they're rows pointing to the same storage object with different
-- page_ranges). Now every comp in the vault has a "Source" badge that
-- opens the original document, jumped to the correct page.
--
-- Design notes:
--   * Storage path is opaque — bucket is `comp-files` (already created
--     in migration 001), prefix convention is
--       source-docs/{user_id}/{yyyy-mm}/{uuid}-{slug}.pdf
--     The user_id prefix means storage-level RLS (path-based) gives us
--     defense-in-depth on top of the table-level RLS below.
--   * page_range is JSONB so we can store either a {start,end} object
--     (continuous range, common case) or an int[] (page list, rare —
--     used when a single comp's data spans non-adjacent pages).
--   * doc_type is an open enum we expect to grow (we'll add 'survey',
--     'tax_record', 'plat' etc. as new doc types start flowing).
--   * is_extraction_source = true on Phase 2c rows. Leaving the flag
--     means future broker-attached files (Phase 3 nicety) can live in
--     the same table without confusion.
--   * uploaded_by stamps WHO did the import — useful when team members
--     start importing into the shared vault.

CREATE TABLE IF NOT EXISTS comp_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comp_id UUID NOT NULL REFERENCES comps(id) ON DELETE CASCADE,

  -- Storage reference — bucket fixed at comp-files (from migration 001).
  -- We store the path only; the signed-URL helper assembles the
  -- full URL at read time so signed-URL TTLs stay short.
  storage_path TEXT NOT NULL,

  -- Display metadata. original_filename is what the broker uploaded
  -- (e.g. "Borgelt Appraisal 2024.pdf") — preserved for UI even though
  -- storage_path uses a uuid-prefixed slug.
  original_filename TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,

  -- Which pages of the source doc back this specific comp?
  -- Examples:
  --   {"start": 2, "end": 3}        — comp came from pages 2-3
  --   {"start": 1, "end": 1}        — single-page comp
  --   {"pages": [1, 5, 7]}          — discontinuous (rare)
  -- nullable when unknown (chunked-path fallback can't always say).
  page_range JSONB,

  -- Open string enum. Set by the document-type classifier or the
  -- extraction path (boundary detection knows what shape it found).
  doc_type TEXT CHECK (
    doc_type IS NULL OR doc_type IN (
      'appraisal',      -- single- or multi-comp appraisal report
      'mls',            -- MLS sold sheet
      'closing',        -- HUD-1 / settlement statement
      'flyer',          -- marketing flyer (rare — usually rejected upstream)
      'broker_notes',   -- broker-typed prose pasted into import chat
      'other'
    )
  ),

  -- Phase 2c rows always have this true. Reserved for Phase 3 broker
  -- uploads (a broker manually attaches a survey PDF to an existing
  -- comp): those land as is_extraction_source=false.
  is_extraction_source BOOLEAN NOT NULL DEFAULT true,

  -- Provenance.
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the common access pattern: "show me all docs for this comp"
CREATE INDEX IF NOT EXISTS idx_comp_documents_comp_id
  ON comp_documents(comp_id);

-- Index for the "what did this user upload recently?" debug pattern
-- and for the future "show me my recent imports" UI.
CREATE INDEX IF NOT EXISTS idx_comp_documents_uploaded_by_at
  ON comp_documents(uploaded_by, uploaded_at DESC);

-- ============================================================
-- RLS
-- ============================================================
-- comp_documents access mirrors comps access: if you can see the
-- comp, you can see its source documents. We don't duplicate the
-- comps RLS logic — we EXISTS-check against comps and let that
-- table's policies decide (transitive auth).

ALTER TABLE comp_documents ENABLE ROW LEVEL SECURITY;

-- SELECT: any comp the user can read, they can read its docs.
CREATE POLICY "View docs for accessible comps" ON comp_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM comps
      WHERE comps.id = comp_documents.comp_id
    )
  );
-- ↑ The EXISTS sub-select is itself RLS-filtered. If the calling user
-- can't see the comp (none of the four comps SELECT policies grant
-- access), the EXISTS returns false and the doc row is hidden.

-- INSERT: only the user who created the comp can attach docs to it.
-- Phase 2c uploads happen during import, so comps.created_by ==
-- auth.uid() at insert time. Phase 3 broker uploads (if/when added)
-- will hit this same check.
CREATE POLICY "Insert docs for own comps" ON comp_documents
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM comps
      WHERE comps.id = comp_documents.comp_id
        AND comps.created_by = auth.uid()
    )
  );

-- UPDATE: rare. Keep tight — only the comp owner.
CREATE POLICY "Update docs for own comps" ON comp_documents
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM comps
      WHERE comps.id = comp_documents.comp_id
        AND comps.created_by = auth.uid()
    )
  );

-- DELETE: only the comp owner. Note the storage object is NOT auto-
-- deleted — that lives in storage.objects RLS. Caller is responsible
-- for deleting both rows when a broker wants the doc gone.
CREATE POLICY "Delete docs for own comps" ON comp_documents
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM comps
      WHERE comps.id = comp_documents.comp_id
        AND comps.created_by = auth.uid()
    )
  );

-- Anon read access for shared CMA reports — mirrors migration 008's
-- pattern. If the shared CMA contains a comp, the anon viewer should
-- be able to fetch its source document for verification on the share
-- page. They get a signed URL via the share API (not direct storage
-- access).
CREATE POLICY "Anon view docs for shared CMA comps" ON comp_documents
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM cmas
      WHERE cmas.share_token IS NOT NULL
        AND comp_documents.comp_id = ANY(cmas.selected_comp_ids)
    )
  );

GRANT SELECT ON comp_documents TO anon;

-- Schema cache reload — PostgREST picks up the new table immediately.
NOTIFY pgrst, 'reload schema';
