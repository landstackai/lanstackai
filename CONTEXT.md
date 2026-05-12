# Lanstackai — Working Context

_Auto-generated from session transcript on May 10, 2026_

This file is read at the start of any new Claude Code session so we don't lose context. Edit freely.

## User profile

- Complete coding beginner — no programming experience.
- Real estate broker building a CMA (Comparative Market Analysis) tool.
- Texas / rural land focus.
- Communicate in plain English, no jargon, walk through commands step-by-step.
- Don't chain instructions; confirm understanding between steps.

## Project at a glance

- **App:** lanstackai — Land Intelligence Platform
- **Repo:** github.com/landstackai/lanstackai
- **Local path:** `/Users/louieswope/Downloads/lanstackai`
- **Stack:** Next.js 14, TypeScript, Supabase (Postgres + Auth + RLS), Mapbox GL, Tailwind, lucide-react icons
- **Hosting:** Vercel (vercel.json present)
- **Dev server:** `cd ~/Downloads/lanstackai && npm run dev` → http://localhost:3000

## Most-edited files (signal of what we work on most)

- `src/app/dashboard/map/page.tsx` — 202 edits
- `src/app/api/import-chat/route.ts` — 31 edits
- `src/app/report/[token]/page.tsx` — 18 edits
- `src/app/api/comp/[id]/find-listing/route.ts` — 15 edits
- `src/app/api/comp/[id]/enrich-boundary/route.ts` — 11 edits
- `src/app/dashboard/cma/page.tsx` — 9 edits
- `src/components/comp/CompModal.tsx` — 9 edits
- `src/app/dashboard/import/page.tsx` — 7 edits
- `src/components/map/ParcelMerge.tsx` — 6 edits
- `.env.local` — 4 edits
- `src/app/api/parcel/route.ts` — 4 edits
- `src/lib/utils/countyParcels.ts` — 4 edits
- `src/app/api/county-parcels/[county]/route.ts` — 3 edits
- `.env.local.example` — 2 edits
- `src/lib/utils/pdfToImages.ts` — 2 edits

## Visual DNA — DO NOT DRIFT FROM THIS

Color semantics are sacred. The broker has built muscle memory; never re-invent.

| Color | Meaning |
|---|---|
| Sage/emerald `#34d399` | Brand · primary value highlights · acres · $/acre |
| Yellow `#facc15` | The subject property (always) |
| Amber `#fbbf24` | Land-only adjustments · improvement values |
| Blue-400 `#60a5fa` | Hover/selection states · CMA mode · improvements |
| Purple-500 | AI features · online listing |
| Red-400 | Destructive only |

**Card pattern:** `bg-card border border-border rounded-xl` for every distinct content unit.
**Section labels:** `text-[10px] font-bold uppercase tracking-wider text-slate-500`.
**Mono font** (`font-mono`) for all numeric values.

## Surfaces that exist

1. **Map dashboard** (`/dashboard/map`) — primary broker workspace. ~3100 LOC. Comp library, CMA build mode, CMA workspace mode (`?cma=ID`).
2. **CMA list** (`/dashboard/cma`) — broker sees their saved CMAs.
3. **Vault** (`/dashboard/vault`) — broker's stored documents.
4. **Import** (`/dashboard/import`) — broker imports comps from PDFs/MLS.
5. **Share report** (`/report/[token]`) — public-facing read-only CMA sent to clients via share link.

## Architectural rules established

- **Broker workspace is the design canvas.** Share/client surfaces are derivatives — they should mirror workspace format with translation layers, not invent their own UI.
- **Public share page must NOT expose broker contact info** (name, phone, email, brokerage). Migration 008 enforces this at the database level — anon role can read `cmas` and `comps` but never `profiles`.
- **Map sizing in flex containers needs `h-screen` not `min-h-screen`.** Safari collapses flex children to 0 height with `min-h-screen`. Map containers also need explicit `map.resize()` calls after layout settles.
- **Hover sync** between comp cards and map pins is bi-directional — implemented via `markerElsRef` Map keyed by comp id, with imperative styling effect on `hoveredCompId` change.
- **Smart description preview**: split by sentence boundaries (`(?<=[.!?])\s+(?=[A-Z])`), preview = first 3 sentences (workspace) or 5 sentences (detail panel). Avoids cutting mid-sentence.

## Database & RLS

- **Migrations live at:** `supabase/migrations/`
- **Latest:** `008_public_share_rls.sql` — opens anon SELECT on `cmas` (where share_token set, not expired) and `comps` (where referenced by a non-expired shared CMA's `selected_comp_ids`). Plus anon UPDATE on `cmas.share_views` for view tracking.
- **Apply via:** Supabase Dashboard SQL Editor OR `supabase db push` from project root.
- **Profiles is intentionally NOT in 008.** Broker contact info stays private.

## Conventions for new code

- All new code uses TypeScript with explicit types when shapes are clear.
- Tailwind only — no inline styles except for dynamic positioning (e.g., map markers).
- Use lucide-react for all icons.
- Format dollars with `formatCurrency`, $/ac with `formatPPA`, acres with `formatAcres` (from `@/lib/utils`).
- For optimistic UI updates: update local state first, then persist to Supabase, with toast on error.

## Vocabulary translation: broker → client

When rendering for clients (non-industry), translate terminology:

| Broker term | Client term |
|---|---|
| `ECV` (after $) | drop entirely |
| `All-in $/Ac` | `Per acre` (with tooltip: "Sale price ÷ acres") |
| `Land $/Ac` | `Land only $/ac` (tooltip: "After backing out building value") |
| `Improvements` | `Buildings on site` |
| `Improvement Adjustment` | `Building value backed out` |
| `Broker-estimated` | tooltip: "Estimated by your broker, not from a formal appraisal" |
| `Water: Strong` | `Strong year-round source` |
| `Road: Medium` | `Medium — good access` |
| `Ag exemption: true` | `Has agricultural tax exemption — lower property taxes` |
| `ADJ` badge | omit (internal flag) |
| `Grantor → Grantee` | `Sold by → Sold to` (or omit) |
| `Confidence: Verified` | omit (broker QA only) |
| `Recording: 12345` | omit (legal trivia) |

## Decisions / preferences expressed by user (recent)

- _okay so i can use the interactive map within regrid that shows all the parcels. they should be there and this is what i want my map to look like._
- _do i want it to be service account?_
- _Okay I need it to auto map the properties if possible. I think we need a more accurate updated parcel map. for example blanco has a more updated parcel map in its cad_
- _once we upload the pdf it needs to locate the property with the coordinaets detect the owner and map all adjacent properties with the same ownership name and merge boundaries'
also the map needs to ov_
- _also i want the outline of the parcel to be red_
- _comp details on the right need to hae acreage in its own box, add property description first 5 senteces with ability to expand, the confiedence of the comp. and improvements details. and ownership tra_
- _okay when editing comp i need the ability to reselect certain parcel overlays to remap correct parcels thart have been sold_
- _when you log in first thing you see needs to be interactive map. also, need to map subject property in interactrive space then from there click on the comps you want to use._
- _once you map the subject property, and select the comps it needs to then create a seperate interface where it just has those properties on a interactive map and be able to go through each one in more _
- _also when you click a parcel and map it needs to give you option to create as subject/create cma you already have add as existing and create comp_
- _when you go to CMA then click on one the reports the subkect map property is not subject property does not show up on the map it needs to have a subject property pin and boundary shapes. also all the _
- _example: map subject property needs to be mapped_
- _I want it to be shapped mapped with boundaries not just a map._
- _We can also have a Build CMA report on the side. Where it opens a blank map not showing the comp overlays you select parcel to map. and it auto detects best 3-10 comps in the area based on size featur_
- _okay the same way when you hover a comp. on the right panel it highlights which comp it is on the map. the same needs to happen when you hover the pin on the map. it needs to highlight which comp it i_
- _Id like to also make a higher level average where if possible and the information is available to back out the improvement cost. Goal would be to better price and have less skewed values. example a co_
- _Correct version: Feature: Adjusted Land Value in CMA Builder

I need to add improvement value adjustments to the CMA builder. Here's exactly what to build:

1. COMP DATA MODEL — add two optional field_
- _yes it is still giving me that message, in addition when we do not add an adjustment you still need to pull and assume there are no improvements on the other ones and pull those comps per acre into th_
- _okay, when you search example: show me all properties 400 acres and above hide all the proeprties that do not meet criteria_
- _when i click on CMA and edit, i tried to remove one comp and it wouldnt let me click saev after._

## Issues that have been hit and resolved

- _it is still not working!_
- _should i delete comps and try and readd them
ReferenceError: Cannot access 'fetchComps' before initialization.
just got this_
- _cross refrence acerage is still not working example comp in real county showing up as 800 + acres and is really 455_
- _see on the right 3 of the comps have blank for land $ per acre_
- _map is still not working let me see your suggestion_

## Most recent work session (May 10, 2026)

- Removed broker contact card from public share page (privacy)
- Migration 008 updated to NOT grant anon access to profiles
- Fixed Safari blank-left-side bug (h-screen + map.resize + ResizeObserver)
- Fixed pin-not-rendering race condition (`mapReady` state gates the marker effect)
- Wired bi-directional hover sync (pin ↔ comp card, blue-400 highlights)
- Restructured share page right panel into 5 narrative sections (Verdict / Range / Evidence / Broker's Read / Fine Print) — but USER WANTS THIS REPLACED with workspace-mirror format
- Added expand chevron on share page comp cards with description, key facts, source links
- Added live thumbnails on source links via WordPress mShots service
- **OPEN: User requested client comp section be a direct mirror of the workspace format with translation layer (per Vocabulary translation table above), not the verdict/range bar approach.** Awaiting choice between A (full workspace mirror) and B (verdict/range header + workspace-mirror evidence).

## How to resume work next session

1. Read this file first.
2. Check `git status` and `git log -5 --oneline` to see recent code state.
3. Check if dev server is running: `lsof -i :3000` — if not, start it: `cd ~/Downloads/lanstackai && npm run dev`.
4. Ask user 'where do you want to pick up?' before assuming.

## Files worth opening immediately when context-switching

- `src/app/report/[token]/page.tsx` — public share/client report page
- `src/app/dashboard/map/page.tsx` — broker workspace (3100 LOC, the canon for design)
- `src/types/index.ts` — Comp, CMA, Profile interfaces
- `supabase/migrations/008_public_share_rls.sql` — latest RLS migration
- `src/lib/utils.ts` — formatPPA / formatCurrency / formatAcres helpers
