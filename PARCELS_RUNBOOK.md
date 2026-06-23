# Parcels Runbook

Living document. Captures plan, state, and decisions for the parcel data foundation.
Update at every checkpoint so a session restart (or a different teammate) can pick up
without reconstructing context.

---

## Why this exists

Landstack needs Texas parcel data (owner names + geometry) for autoLocate and comp
verification. We previously depended on TxGIO (Texas GIS Office) as a single upstream
vendor. TxGIO has shown to be intermittently unreachable, which puts autoLocate at risk
during the pilot.

The plan: self-host parcel data in a dedicated Supabase project, separate from the
production database that powers auth/users/comps. The production DB stays clean and
small; the parcel DB can be rebuilt without affecting customer-facing services.

---

## Current state (update at every checkpoint)

| Item | State |
|---|---|
| Production Supabase (`zmpdkhpzcekclgjsmggs`) | Restored. parcels_tx + search function dropped. Used for auth/users/comps only. 23 MB. |
| Parcels Supabase (separate project) | **NOT YET CREATED.** Awaiting user to provision in dashboard. |
| `/api/parcels-by-owner` endpoint | TxGIO-backed (unchanged from pre-pivot). File: `src/app/api/parcels-by-owner/route.ts`. |
| TxGIO upstream | Down as of last probe. Status unknown; periodic probe not yet set up. |
| StratMap 2025 zips | All 254 present on disk at `data/parcels-2025/zips/`. Integrity verified earlier (104 had been re-downloaded after corrupted parallel-fetch). |
| Migrations 040 + 041 | Code lives in `supabase/migrations/`. Applied then dropped from prod Supabase. Need to re-apply against new parcels project. |
| `scripts/import-parcels.py` | Tested on Frio (13K rows in 2.8s). Updated to run `ST_MakeValid` post-COPY per county. |
| `scripts/probe-dbf-schemas.py` | New. Run before bulk import to detect per-county DBF schema variance. |

---

## Architecture decision (locked)

- **Host:** Supabase Pro, separate project (not the prod project). Region us-east-1.
  Cost: ~$30/mo flat (Pro $25 + IPv4 add-on ~$4 + storage overage ~$1).
- **Scope:** Statewide (all 254 counties), but imported incrementally. Frio first, then
  3-county pilot (Frio + Bexar + Brewster for shape/scale variance), then statewide.
- **Why Supabase Pro over DO/Neon:** familiarity with the tooling (migrations 040+041 work
  as-is), built-in PgBouncer pooling, integrated dashboard for query observability,
  PITR backups. $5-10/mo premium over DO bought operational simplicity.

---

## Hard rules learned the hard way

1. **No writes to production Supabase from this work.** Parcel data lives entirely in the
   separate project. Production DB is for auth/users/comps.
2. **Size budget before any data import.** Rows × bytes vs destination capacity, written
   down, BEFORE running the import. Failure to do this caused production DB to hit
   read-only mode earlier this session.
3. **One county, then stop and measure.** Run Frio, check disk delta, project to 254,
   decide go/no-go on remaining counties. Don't bulk import based on hope.
4. **No destructive operations without explicit yes/no confirmation.** DROP, TRUNCATE,
   DELETE all require confirmation, even if I just proposed them.
5. **After two pivots, stop and re-examine the plan.** A third tactical change is a
   signal to question strategy, not tactics.
6. **Distinguish what I know from what I'm guessing.** When asked about external systems
   (Supabase limits, vendor pricing), verify via docs/probe rather than recall from
   memory. Label uncertainty explicitly.
7. **No relative time references.** Use precise references — commit hash, file path,
   line number, "earlier in this thread" — rather than "yesterday" / "this morning."

---

## Step-by-step plan (with checkpoints)

Each step has a status. Update when complete. Each destructive step requires explicit
"yes" before execution.

### Phase 1 — Setup (no spend, no DB writes)

- [x] **1.1** Write `scripts/probe-dbf-schemas.py` to detect per-county DBF variance.
- [x] **1.2** Add `ST_MakeValid` post-COPY to `scripts/import-parcels.py`.
- [x] **1.3** Write this runbook.
- [ ] **1.4** Run `scripts/probe-dbf-schemas.py` — confirm all 254 counties have a
      compatible schema, or surface the ones that don't.

### Phase 2 — Provision (one-time spend starts)

- [ ] **2.1** USER: create new Supabase project (Pro tier, us-east-1). Name suggestion:
      `landstack-parcels`. Enable IPv4 add-on.
- [ ] **2.2** USER: paste new project's DB connection URL.
- [ ] **2.3** Claude: add `PARCELS_DB_URL` to `.env.local` (gitignored).

### Phase 3 — Schema + smoke (DB writes start, reversible)

- [ ] **3.1** Audit `migrations/041_parcels_search_function.sql` for SQL injection
      in the dynamic-token WHERE clause.
- [ ] **3.2** Apply `040_parcels_tx_foundation.sql` against parcels DB.
- [ ] **3.3** Apply `041_parcels_search_function.sql` against parcels DB.
- [ ] **3.4** Verify table + function exist via `\dt` and `\df`.

### Phase 4 — Pilot import (3 representative counties)

- [ ] **4.1** Import Frio (48163) — smallest validated baseline.
- [ ] **4.2** Import Bexar (48029) — largest urban (~500K parcels).
- [ ] **4.3** Import Brewster (48043) — large rural (~3K parcels, huge area).
- [ ] **4.4** Run smoke queries: Wesla / Mikulencak / Bagan owner searches.
- [ ] **4.5** Run `EXPLAIN ANALYZE` on representative queries, capture latency.
- [ ] **4.6** Measure disk delta, project statewide cost.
- [ ] **4.7** CHECKPOINT: review numbers with user before statewide import.

### Phase 5 — Statewide import (1-2 hr unattended)

- [ ] **5.1** Run `scripts/import-parcels.py` (no flags = all 254 counties).
- [ ] **5.2** Verify county count + total row count against expectations.
- [ ] **5.3** `VACUUM ANALYZE parcels_tx` to refresh planner stats.
- [ ] **5.4** Per-county sanity check: pick 5 random parcels per county, verify shape +
      owner via the search function.

### Phase 6 — Endpoint cutover (production change, reversible)

- [ ] **6.1** Create `src/app/api/parcels-by-owner-v2/route.ts` querying the new DB.
      Same response shape as the existing TxGIO route.
- [ ] **6.2** Deploy to Vercel preview only. Test against the preview URL.
- [ ] **6.3** Run `scripts/batch-validate-frio-claude.mjs` (if it exists) against v2.
- [ ] **6.4** Run both endpoints in parallel for ~24h, compare behavior.
- [ ] **6.5** CHECKPOINT: review behavioral parity before promoting.
- [ ] **6.6** Swap default endpoint: rename old to `-fallback`, rename v2 to default.
- [ ] **6.7** Keep `-fallback` (TxGIO) live for at least a week as safety net.

---

## Rollback at each phase

| If we stop at... | To unwind... |
|---|---|
| Phase 1 | Nothing to unwind. Code only. |
| Phase 2 | Delete the Supabase project. |
| Phase 3 | DROP TABLE parcels_tx on parcels project. Project still exists, no harm. |
| Phase 4 | `DELETE FROM parcels_tx WHERE fips = '...'` per county. |
| Phase 5 | Same as Phase 4 but for all counties. |
| Phase 6.1-6.5 | Delete the v2 route file. No deployed change. |
| Phase 6.6 (swap committed) | `git revert` the swap commit. Redeploy. TxGIO route takes over. |

---

## Open questions / TBD

- Whether `migrations/041_parcels_search_function.sql` has a SQL injection gap.
  Pending audit in step 3.1.
- Whether all 254 counties have an identical DBF schema. Pending probe in step 1.4.
- Whether Supabase Micro compute handles 13M-row statewide queries, or if a Small
  compute upgrade ($15/mo) is needed. Pending measurement in step 4.5.
- StratMap update cadence — when does 2026 data drop, and does its schema match 2025?
  Will need a re-import strategy then.

---

## Sources / references

- StratMap collection: https://data.geographic.texas.gov/collection/?c=0fa04328-872e-481c-b453-126a74777593
- Supabase Pro pricing: https://supabase.com/pricing (verified mid-2026)
- Supabase IPv4 docs: https://supabase.com/docs/guides/platform/ipv4-address
- TxGIO query API: https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer
