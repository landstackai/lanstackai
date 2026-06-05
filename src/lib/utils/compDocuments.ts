// Phase 2c — source document storage helper.
//
// Every import session uploads the broker's PDF to Supabase Storage
// ONCE (regardless of how many comps came out of it) and writes one
// comp_documents row per comp linking back to that storage object +
// the page range that comp was extracted from.
//
// The user clicks a comp in the vault → sees "Source: Borgelt
// Appraisal.pdf (pp. 2-3)" → clicks → opens the PDF at the right page.
// That's the broker-facing audit trail; this file is the plumbing.
//
// Why one upload + N rows instead of N uploads:
//   • A typical multi-comp appraisal is 5-15 MB. Uploading once and
//     pointing five comps at it saves both storage and bandwidth.
//   • If the broker re-imports the same doc later (mistake), the
//     deduper in import/page.tsx catches the comps but the source
//     doc storage isn't duplicated either — we re-upload to a new
//     path but the cost is negligible vs the comps dedupe nicety.
//   • We could de-dupe storage too via content hash, but that's
//     Phase 3 polish. For now, one upload per import session is
//     the right scope.

import { createClient } from '@/lib/supabase/client';

const SOURCE_BUCKET = 'comp-files';

export interface UploadSourceDocumentParams {
  // The file the broker uploaded (or a reconstructed File from chat-paste).
  file: File;
  // User who owns this import session — used for the storage prefix
  // (defense-in-depth on top of table RLS) and for uploaded_by stamping.
  userId: string;
}

export interface UploadedSourceDocument {
  storagePath: string;       // path inside the bucket
  originalFilename: string;  // for UI display
  mimeType: string;
  fileSizeBytes: number;
}

/**
 * Upload the source PDF to Supabase Storage and return the path +
 * metadata. The caller is responsible for writing comp_documents
 * rows that reference this upload (see attachSourceDocumentToComps).
 *
 * Path convention:
 *   source-docs/{userId}/{yyyy-mm}/{uuid}-{slugified-filename}
 *
 * Yes the path is opaque (UUID prefix prevents collisions when two
 * brokers upload the same filename), but original_filename is
 * preserved in the comp_documents row so the UI never has to show
 * the uuid.
 */
export async function uploadSourceDocument(
  params: UploadSourceDocumentParams,
): Promise<UploadedSourceDocument | null> {
  const { file, userId } = params;
  if (!file || !userId) return null;

  const supabase = createClient();

  // ─── Path construction ──────────────────────────────────────────
  // Slugify the original filename so the storage path is URL-safe
  // but still recognizable in the storage browser (helpful for ops).
  const slug = file.name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')           // drop extension
    .replace(/[^a-z0-9]+/g, '-')       // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '')           // trim leading/trailing
    .slice(0, 80) || 'document';       // cap length
  const ext = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'bin';
  const yyyyMm = new Date().toISOString().slice(0, 7); // 2026-06
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const storagePath = `source-docs/${userId}/${yyyyMm}/${uuid}-${slug}.${ext}`;

  // ─── Upload ─────────────────────────────────────────────────────
  // upsert: false because the path is UUID-prefixed and collisions
  // are impossible. If we ever see "already exists", something is
  // very wrong upstream — let it fail loudly.
  const { error } = await supabase.storage
    .from(SOURCE_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream',
    });

  if (error) {
    console.error('[compDocuments] upload failed:', error.message, { storagePath });
    return null;
  }

  return {
    storagePath,
    originalFilename: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSizeBytes: file.size,
  };
}

export interface AttachSourceDocumentParams {
  // The IDs of comps freshly inserted to the vault that came out of
  // this import session.
  compIds: string[];
  // Doc info from uploadSourceDocument().
  upload: UploadedSourceDocument;
  // Per-comp page-range hints from the boundary detector (if the
  // boundary path was used). Keyed by comp id; entries without a
  // page range get null (the chunked path can't always say).
  pageRangeByCompId?: Record<string, { start: number; end: number } | null>;
  // Document type — boundary path can usually classify this from the
  // detection signal; chunked path passes null and we fall back to
  // 'other' until Phase 2c.1 adds a classifier.
  docType?: 'appraisal' | 'mls' | 'closing' | 'flyer' | 'broker_notes' | 'other' | null;
  // Who uploaded — stamped on every row.
  userId: string;
}

/**
 * Write one comp_documents row per comp linking to the uploaded source.
 *
 * Fail-soft: if the insert errors (table missing, RLS reject, etc.),
 * we log and return false — the comps themselves still saved to the
 * vault, only the provenance link is missing. This is intentional —
 * the audit trail is a nicety, not a blocker for getting comps imported.
 */
export async function attachSourceDocumentToComps(
  params: AttachSourceDocumentParams,
): Promise<boolean> {
  const { compIds, upload, pageRangeByCompId, docType, userId } = params;
  if (!compIds.length) return true;

  const supabase = createClient();

  const rows = compIds.map((compId) => ({
    comp_id: compId,
    storage_path: upload.storagePath,
    original_filename: upload.originalFilename,
    mime_type: upload.mimeType,
    file_size_bytes: upload.fileSizeBytes,
    page_range: pageRangeByCompId?.[compId] ?? null,
    doc_type: docType ?? null,
    is_extraction_source: true,
    uploaded_by: userId,
  }));

  const { error } = await supabase.from('comp_documents').insert(rows);
  if (error) {
    // Most likely cause if this fails: migration 037 hasn't been
    // applied to the target Supabase project yet. Log loudly so
    // ops can see "you need to run the migration" rather than
    // "imports are silently missing source links".
    console.error('[compDocuments] attach failed:', error.message, {
      compIds: compIds.length,
      storagePath: upload.storagePath,
    });
    return false;
  }
  console.log(
    `[compDocuments] attached ${rows.length} source-doc rows ` +
    `(${upload.originalFilename}, ${docType || 'unclassified'})`
  );
  return true;
}

/**
 * Resolve a comp_documents row's storage_path to a signed URL the
 * broker (or share-page anon viewer) can open in a new tab. URLs
 * expire after `ttlSeconds` so leaked links go stale fast.
 *
 * Returns null on failure (RLS rejection, missing file, etc.).
 */
export async function getSourceDocumentSignedUrl(
  storagePath: string,
  ttlSeconds = 60 * 60, // 1 hour
): Promise<string | null> {
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(SOURCE_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    console.error('[compDocuments] signedUrl failed:', error?.message);
    return null;
  }
  return data.signedUrl;
}
