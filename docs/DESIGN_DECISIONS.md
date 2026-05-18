# Design Decisions

Captured during the week of May 13–18, 2026, while the verification stack was
built out. This is a living document — when we make architectural decisions or
explicitly defer something, add it here. Future sessions read this so we don't
re-litigate the same trade-offs from scratch.

> Scope: covers the comp-import / autoLocate / verification pipeline. Does not
> cover CMA generation, vault management, or auth — those live in their own
> code paths and weren't touched by this week's work.

---

## 1. The trust model

**Anchor principle:** correctness over automation. The system is built on
broker trust. Every silent decision the system makes is an erosion of trust if
that decision turns out wrong. Therefore:

- Numeric fields are never silently auto-corrected. If math doesn't add up,
  the row is **flagged** for human review — the system doesn't try to guess
  which field is wrong.
- High-confidence pins still get a human glance via thumbnail verification.
  "HIGH confidence" today means "no internal contradiction found," not
  "verified correct."
- Every comp gets one explicit human decision (Looks right / Needs review)
  before going live. No silent saves from the import flow.

**Failure-safe over fail-confident:** when autoLocate can't find a confident
match, it returns `null` (and the comp lands in the vault with no pin + a red
MapPinOff badge). Better than confidently pinning to a wrong parcel.

---

## 2. Pipeline overview

```
PDF / link / paste
    │
    ▼
AI extraction (/api/import-chat or extractFromChunkedPdf)
    │
    ├─ Math identity gate  ← acres × ppa = sale_price within 1%?
    │  Fail → flag needs_extraction_review (amber badge in vault)
    │
    ▼
autoLocate (browser)
    │
    ├─ Lat/lng-first seed  ← if explicit coords present, point-in-polygon
    │                         + corroboration; falls through to owner search
    │                         when seed doesn't validate
    │
    ├─ Owner search        ← grantee → grantor → property_name
    │                         tokenize, query TxGIO by county, AND-filter
    │                         survivors, adjacency-cluster, pick within ±50%
    │
    └─ Returns: pin + boundary, OR null
    │
    ▼
Diagnostic log row  ← captures input snapshot, pipeline path, outcome
    │
    ▼
Verification card (thumbnail UI)
    │
    ├─ LEFT: aerial extracted from PDF, or satellite of source coords,
    │         or text panel with grantee/grantor/description
    ├─ RIGHT: matched parcel boundary outlined on Mapbox satellite
    │         (auto-fit zoom)
    │
    ├─ [✓ Looks right]    → save with needs_location_review=false
    └─ [🕐 Needs review]  → save with needs_location_review=true
                               opens map in new tab focused on the comp
    │
    ▼
Vault — three possible badges next to county:
    📍❌ red    → no pin at all, place manually
    ⚠ amber    → math identity failed, verify values
    🕐 gray    → location wasn't broker-verified
```

---

## 3. Shipped this week

| Commit | Build | What it does |
|---|---|---|
| `5334ab1` | Tokenizer + adjacency + dedup + sanity gate v1 | Digit-prefix tokens preserved (9L, 4F), punctuation strip widened, dedup key includes grantee, $/ac auto-correct at 10% (later superseded) |
| `c913fdf` | Diagnostic logging | `autolocate_diagnostics` table, POST endpoint, browser hooks in autoLocate, `/api/health/recent-runs` admin view |
| `math-identity-gate` branch | Math identity gate v2 | Replaces v1 auto-correct: 1% threshold, flag-only via `needs_extraction_review`, amber AlertTriangle badge in vault |
| `lat-lng-first` branch | Lat/lng-first seed | When source has explicit coords, point-in-polygon → seed parcel → expand via existing cluster logic → corroborate (owner OR acres match) before committing |
| `thumbnail-verification` branch | Verification UI + clock/no-pin badges + PDF aerial extraction | Per-comp cards with side-by-side thumbnails, Looks right/Needs review buttons, gray Clock + red MapPinOff badges in vault, embedded PDF image extraction via pdfjs |

Three branches are stacked and unmerged pending broker validation:
`main ← math-identity-gate ← lat-lng-first ← thumbnail-verification`.

---

## 4. Verification workflow decisions

### Math identity gate

- **Threshold: 1%** (was 10% in the v1 auto-correct version). 1% tolerates
  rounding when ppa is stated as a clean dollar value (e.g., "$4,750/ac" vs.
  actual price/acres = $4,749.84). Catches hallucinations like L&D Farm and
  Ranch (8,820 ac extracted for a 1,179 ac comp, Δ86.6%).
- **Flag, don't auto-correct.** Setting `needs_extraction_review = true`
  surfaces the row with an amber AlertTriangle in the vault. Broker decides
  which of acres/price/ppa is wrong; system doesn't guess.
- **Auto-correct was rejected as a category error.** Even though the L&D case
  was "obviously acres is wrong," the gate has no way to KNOW that — in a
  different failure mode (AI hallucinated ppa, acres correct), auto-correcting
  acres would destroy the correct value.

### Three vault badges, distinct meanings

| Icon | Color | Meaning | Trigger |
|---|---|---|---|
| 📍❌ MapPinOff | red | No location at all | `latitude IS NULL OR longitude IS NULL` |
| ⚠ AlertTriangle | amber | Math values disagree | `needs_extraction_review = TRUE` |
| 🕐 Clock | gray | Pin not broker-verified | `needs_location_review = TRUE AND latitude IS NOT NULL` |

Red sorts ahead of amber and gray because it's the most actionable — comp is
literally invisible on the map until placed. Gray suppresses when red is
present (a missing pin can't have been visually verified, so showing both is
redundant noise).

### Universal verification (not opt-in by confidence)

Every comp goes through the thumbnail screen, including HIGH confidence pins.
Reasoning: "HIGH" today means "pipeline didn't detect a contradiction," which
is not the same as "verified correct." Coincidental owner+acreage matches
(Mode 4: same owner has multiple distinct ranches) still produce HIGH
confidence pins on the wrong tract — only the broker's eye catches these.

UI calibrates ATTENTION by confidence (HIGH = quick green-badge glance; LOW =
red border + reason explanation + emphasis on the Wrong button), but the
verification step itself happens for all comps.

### Navigation philosophy

Revised May 18 after Safari's popup blocker proved willing to silently
reject `window.open()` calls from buttons even when invoked synchronously
from the click handler. The original new-tab design fell apart on Safari
under default popup-blocker settings.

Current behavior:

- **"Looks right"** → toast with optional "View on map" link, rendered as
  an anchor `<a target="_blank">` so it's browser-native navigation (never
  popup-blocked). Broker can ignore the toast or click to view. No
  automatic navigation.
- **"Needs review"** → save THIS comp + parallel-save all OTHER pending
  comps as `needs_location_review=true`, THEN same-tab navigate to the
  map focused on the comp. The bulk-save preserves the broker's work on
  multi-comp PDFs — other cards appear in the vault with gray clock
  badges instead of disappearing.

This is Option B from the May 17 discussion. Alternatives considered:

- Option A (same-tab nav, lose other pending comps): rejected. Brokers
  uploading multi-comp PDFs would silently lose work.
- Option C (new tab via `window.open` or anchor target=_blank): rejected
  after Safari testing. `window.open` is unreliable under default popup
  blockers. Anchor target=_blank works for navigation BUT doesn't run
  the JS save handler reliably in all browsers when combined with
  navigation — anchor click semantics make the timing fragile.

Option B is the most robust because it uses only same-tab navigation
(`router.push`) which is always allowed, AND solves the multi-comp
preservation problem at the data layer by saving everything before
navigating.

### Bulk-save semantics

- Per-card "Looks right" → `needs_location_review = false` (verified)
- Per-card "Needs review" → `needs_location_review = true` (flagged)
- Bulk "Save all for review later" → all comps get `needs_location_review =
  true`. Broker explicitly chose to bypass the per-card flow; system surfaces
  them all in the vault for follow-up via the gray clock badge.
- Chunked-PDF silent save path → hard-codes `needs_location_review = true`
  (never went through the visual screen).

---

## 5. Review page architecture (planned, not yet built)

Driven by the user's observation: when broker hits "Needs review," they need
a workspace to actually fix the boundary, not just look at the wrong pin.

### Route

Dedicated route at `/dashboard/review/[compId]`. Rejected adding the new
interactions to the existing `/dashboard/map` page because the map already
serves vault, CMA, and standalone exploration — adding a fourth heavy mode
on top would muddy state and risk regressions in the other workflows.

The existing map page stays exactly as it is. Review is its own thing.

### Aerial overlay strategy

**Tier 1 — auto-align to parcel bbox** (V1 default):
Compute the bounding box of the current `boundary_geojson` and place the
aerial's four corners at those bbox coordinates. Renders as a semi-transparent
raster layer via Mapbox GL's `addSource({type: 'image'})`. Works as long as
the aerial is framed to the property — typical for Stouffer "Ranch Sale" /
"Farm Sale" reports.

**Tier 2 — manual drag-to-align** (V1, on top of Tier 1):
Corner handles on the aerial overlay. Broker grabs and drags to fine-tune
alignment when the auto-bbox isn't quite right. Opacity slider (10%–80%) so
the broker can see through the aerial to the satellite below.

**Tier 3 — AI feature matching** (deferred indefinitely):
Computer vision identifies common features (roads, pivot circles, fences)
between aerial and satellite, auto-computes the geographic transform.
Real engineering investment (2–3 weeks for someone with CV experience).
Software patent unlikely to be commercially defensible (heavy prior art,
post-Alice). Better defensive strategy: capture broker decisions as
proprietary training data (already happening via diagnostic logs +
broker_decision column).

### Boundary editing — two distinct modes

**Reselect parcels (primary):**
Most common case is "system picked 3 parcels, missed the adjacent 4th" or
"system grabbed an extra parcel that shouldn't be in the cluster." Render all
nearby TxGIO parcels as toggleable polygons; clicking adds/removes from the
selection. Save merges selected polygons into the new `boundary_geojson`.

UX: current cluster shown filled-gold; candidates shown thin gray outlines;
click to toggle; live counter shows total acres updating.

**Draw new boundary (secondary, but essential):**
For cases where TxGIO doesn't have the right parcels at all — unrecorded
subdivisions, carve-outs, easements, manual survey results. Mapbox Draw
plugin (or custom vertex-click implementation). Saves freehand polygon
directly to `boundary_geojson`.

Both modes write to the same field. Both have aerial overlay + opacity
slider as visual reference while editing. Cancel reverts to original;
`needs_location_review` stays true until broker explicitly clicks
"Mark verified."

### Six-stage build plan

| Stage | Effort | What |
|---|---|---|
| 1 | 1.5–2 hr | Migration adds `aerial_image` column on comps. Save flow stores extracted aerial. |
| 2 | 2–3 hr | New review page route + layout + side panel + Mark verified button. |
| 3 | 3–4 hr | Tier 1 georeferenced aerial overlay + opacity slider. |
| 4 | 4–6 hr | Reselect parcels mode. |
| 5 | 4–6 hr | Draw new boundary mode. |
| 6 | 1–2 days | Tier 2 drag-to-align corners on aerial overlay. |
| **Total** | **~3–4 days** | |

### State model

- `cancel` → revert to original boundary, `needs_location_review` stays true
- `Save` → write new boundary, `needs_location_review` stays true (broker
  edited but hasn't said "this is right" yet)
- `Mark verified` → set `needs_location_review = false`, clears gray badge
- Aerial overlay state: visible by default when `needs_location_review =
  true`, collapses to a small "📸 Show aerial" toggle button when
  `false` (verification tool no longer needed; toggle re-opens it if broker
  wants it back)

### Per-property only

All review-page features (aerial overlay, reselect, draw, edit) trigger only
in focused-comp mode. The database overview map view stays unchanged.
Showing all aerials simultaneously across the full map would be unusable.

---

## 6. Explicitly NOT building

| Feature | Why not |
|---|---|
| "Remap" button (re-run autoLocate from map) | Doesn't get better information than the first run did. High UX risk of regressing broker's manual edits. If TxGIO data legitimately changed, broker can re-upload the PDF. |
| Aerial overlay on the database-wide map view | Showing 30+ aerials simultaneously is visually unusable. Per-property only. |
| Tier 3 AI georeferencing | Real engineering investment (2–3 weeks) for incremental UX improvement over Tier 2. Wait for evidence Tier 2 isn't precise enough in practice. |
| Software patent on image registration | Heavy prior art post-Alice. Time/money better spent building product + capturing broker-decision data as proprietary moat. |
| Backfilling aerials for existing vault comps | Existing comps stay as they are. Re-import is the path if a specific old comp needs an aerial. |
| Inline LocationPicker in verification card | "Needs review" path opens map in new tab instead. Keeps card screen simple and fast. |
| Polygon boundary overlay on Mapbox URL exceeds length (rare) | Falls back to pin-only rendering. Better than nothing. |

---

## 7. Build queue (next sessions, prioritized)

Active work for upcoming sessions, roughly in the order I expect to
build them. Effort estimates are rough — the real ordering depends on
what gets revealed during validation of the work already shipped.

| # | Build | Effort | Why this order |
|---|---|---|---|
| 1 | **Review page stages 2-6** (the rest of the review page — route + side panel + aerial overlay + reselect parcels + draw boundary + Tier 2 drag-to-align) | ~3-4 days | The Stage 1 foundation (aerial persistence) shipped tonight without a UI to consume it. Building the UI is the natural next step — gives brokers a real workspace for fixing flagged pins. |
| 2 | **URL / link upload extraction** (see §7.1 below) | ~1-2 days | Listings are a real comp source brokers will use alongside PDFs. Currently the import flow only handles PDFs. Discussed in detail on May 17, design approved. |
| 3 | **Vault "Needs review" banner** (counts of red/amber/gray badged comps at top of vault, click to filter) | ~30-45 min | Designed May 17, approved. Surfaces the review queue prominently — brokers shouldn't have to scroll the vault looking for items needing attention. |
| 4 | **Validation + merge to main** of the four stacked branches (math-identity-gate / lat-lng-first / thumbnail-verification / aerial-persistence) | Validation: ongoing. Merge: 10 min. | Real-world usage is the only signal that catches edge cases the design didn't anticipate. Don't merge until broker has run a representative batch of imports through preview. |

### 7.1 URL / link upload extraction (build #2 in queue)

**Status:** designed May 17, approved, awaiting build.

Brokers will paste listing URLs (Land.com, LandsOfTexas, broker's own
site, etc.) as a comp source alongside PDF appraisals. Different shape
of data, different extraction approach, partially-filled comp at output.

**Workflow:**

```
Broker pastes URL into Import
   │
   ▼
Server fetches page (with realistic User-Agent) at /api/import-url
   │
   ├─ ✓ HTML success → structured extraction (OG tags, schema.org JSON-LD,
   │                    known per-site selectors) → AI cleanup pass
   ├─ ⚠ JS-required → fall back to headless browser screenshot → AI vision
   └─ ✗ Blocked → notify broker: "this site blocks automated fetches —
                  paste the listing text manually instead"
   │
   ▼
Returned comp is PARTIALLY filled — flagged as such
   - Has: property name, acres, price (asking), county, description, lat/lng
          if listing has a map, photos
   - Missing: actual sold price, sold date, grantor, grantee, recording info
   │
   ▼
Verification card opens with two distinguishing things:
   - "From listing" label instead of "From appraisal"
   - "Complete missing fields" prompt before "Looks right" enables
     (broker fills in actual sold price + sold date)
   │
   ▼
Same flow from here: Looks right → verified, Needs review → flagged
```

**Site reality:**

| Site | Approach | Notes |
|---|---|---|
| Land.com / LandsOfTexas | Structured HTML parsing | Public listings, OpenGraph metadata available. Probably easiest first target. |
| LandWatch, Hall and Hall, TXLBN | Structured HTML parsing | Public listings, varying anti-scraping. Workable. |
| Zillow / Redfin | Skip for V1 | Aggressive bot blocking, JS-rendered, ToS prohibits. Not worth the engineering. |
| MLS systems (HAR, NTREIS) | Skip for V1 | Require login + IDX license for redistribution. Different category. |
| Broker's own website | Easiest | Broker owns the data. |

**Architectural decisions:**

- **Server-side extraction** (CORS prevents browser fetches of arbitrary
  third-party sites). New endpoint `/api/import-url`.
- **No source aerial** for listing-sourced comps. Listings have ground-level
  photos, not top-down aerials. Verification card's left side defaults to
  text panel for listing imports.
- **Partial comp completion** is mandatory before "Looks right" enables.
  Broker must fill in actual sold price + sold date — listings have asking
  price + list date, neither of which is correct for a CMA comp.
- **Lower default confidence** — listings are marketing copy, not legal
  records. AI extraction shouldn't claim HIGH confidence on listing data
  the way it might on a Stouffer appraisal.

---

## 8. Open questions / unresolved

### Multi-comp PDF aerial attribution

A multi-comp Stouffer-format PDF has separate aerials on separate pages, one
per comp. Today we leave `aerialImage` null for multi-comp imports because
we can't reliably attribute one image to one comp without per-page AI
extraction. Options for V2:

- Per-page AI call that returns "this aerial belongs to comp X"
- Heuristic: assume page N's aerial belongs to the Nth comp returned
- Use the appraisal's table of contents page if it lists per-page comp IDs

### Patent strategy

Briefly discussed; deferred. If pursued, requires real patent attorney
before any public disclosure of the technique. Likely better ROI to focus
on data moat (broker decisions in `autolocate_diagnostics.broker_decision`).

### Regrid integration timing

Several deferred features assume Regrid lands eventually (grantor cross-
check via deed history, parcel ownership variant matching, etc.). Not
budgeted yet.

### Diagnostic data — what does the truth look like?

We now log every autoLocate run. After ~50–200 real broker imports, we'll
have real signal on:

- HIGH-confidence pin rejection rate (does HIGH actually mean correct?)
- How often LocationPicker gets used (does broker frequently need to fix
  pins after import?)
- Which counties / appraisal formats have the highest manual-fallback rate
- AI extraction nondeterminism rate (how often does the same field come back
  different across re-uploads)

These answers should drive the next round of build priorities. Don't
over-build speculatively — wait for the data.

---

## 9. Database schema summary (comps table additions this week)

| Column | Migration | Purpose |
|---|---|---|
| `needs_extraction_review` BOOLEAN | 019 | Math identity gate flag (amber badge) |
| `needs_location_review` BOOLEAN | 020 | Thumbnail verification flag (gray clock badge) |
| `aerial_image` TEXT | 021 (this commit) | Persisted aerial from import for review page reference |

| Table | Migration | Purpose |
|---|---|---|
| `autolocate_diagnostics` | 018 | One row per autoLocate run — input snapshot, path, outcome, broker decision |

### Migrations applied to Supabase

Migrations are NOT auto-applied. They are pasted manually into the Supabase
dashboard SQL editor. Each migration uses `IF NOT EXISTS` clauses so re-runs
are safe.

Status (as of last manual application):
- 018 — applied ✓
- 019 — applied ✓
- 020 — applied ✓
- 021 — pending (this commit)

---

## 10. Branch structure (as of this commit)

```
main
  └── math-identity-gate
        └── lat-lng-first
              └── thumbnail-verification
                    └── aerial-persistence  ← you are here
```

All four pending branches are validated on the `thumbnail-verification`
preview deploy. Merge to main happens when broker has finished validating
the verification UI in production-like usage. No env flags need to flip
when merging — adjacency clustering is already on in production from the
earlier merge.

---

## 11. Conventions

- New badges go in the vault list, county column, sorted by urgency
  (red → amber → gray)
- Migrations live in `supabase/migrations/NNN_description.sql`, sequential
  numbering, each idempotent via `IF NOT EXISTS`
- Diagnostic-only endpoints live under `/api/health/*`, no-auth, service-role
  for DB access
- Browser autoLocate has an optional `_diag` collector that the wrapper
  builds up and POSTs to `/api/diagnostics/autolocate` fire-and-forget
- All feature work uses stacked branches, not direct main commits, even for
  the smallest changes
