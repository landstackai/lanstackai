# Parcels Foundation — Morning Runbook

**Goal:** Replace `/api/parcels-by-owner`'s TxGIO live-API dependency with self-hosted parcel data in Supabase Postgres. Stops the multi-minute hangs when TxGIO is flaky. Nothing else changes.

**Time budget:** ~3 hours of focused work, mostly waiting on the bulk import.

**Risk:** Low. The endpoint replacement is small, deterministic, and validated against the same 13 fixtures we've used all week. Production stays on TxGIO until the validation passes and you sign off the push.

---

## Pre-flight (15 min)

### 1. Confirm the overnight download finished

```bash
cd ~/Downloads/lanstackai/data/parcels-2025
ls zips/ | wc -l       # Should be 254
du -sh zips/           # Should be ~9 GB
```

If it didn't finish, restart with:
```bash
nohup bash -c 'cat urls.txt | xargs -P 8 -I {} bash -c "
url=\"\$1\"
fname=\"zips/\$(basename \$url)\"
[ -f \"\$fname\" ] && [ \$(stat -f%z \"\$fname\") -gt 1000 ] && exit 0
curl -sL --max-time 120 \
  -H \"Referer: https://data.geographic.texas.gov/\" \
  -A \"Mozilla/5.0\" \
  -o \"\$fname\" \"\$url\"
" _ {}' > download.log 2>&1 &
```
Resumes from where it stopped (already-downloaded files are skipped).

### 2. Confirm GDAL installed

```bash
ogr2ogr --version       # Should print "GDAL 3.x.x"
```

If still installing or missing:
```bash
brew install gdal
```

### 3. Enable Supabase extensions (30 sec, one-time)

In Supabase Dashboard for the `landstack ai` project:
- **Database → Extensions**
- Enable **`postgis`**
- Enable **`pg_trgm`**

### 4. Get the direct Postgres connection string (30 sec)

- **Supabase Dashboard → Project Settings → Database**
- Section: **Connection string**
- Mode: **URI**
- Click **Reveal** password (or use the dynamic one)
- Copy the full URL — looks like:
  ```
  postgresql://postgres.zmpdkhpzcekclgjsmggs:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
  ```
- Export it in your shell:
  ```bash
  export SUPABASE_DB_URL='postgresql://...'
  ```

---

## Step 1: Apply the schema (5 min)

```bash
cd ~/Downloads/lanstackai

# Apply migration 040 (table + indexes)
psql "$SUPABASE_DB_URL" -f supabase/migrations/040_parcels_tx_foundation.sql

# Apply migration 041 (search function)
psql "$SUPABASE_DB_URL" -f supabase/migrations/041_parcels_search_function.sql
```

**Expected output:**
```
DO
CREATE TABLE
CREATE INDEX (×5)
ALTER TABLE
DROP POLICY
CREATE POLICY
COMMENT (×4)
DROP FUNCTION
CREATE FUNCTION
COMMENT
GRANT
```

If any step fails: read the error. Most common cause is extensions not enabled (step 3 of pre-flight).

---

## Step 2: Bulk import (60-90 min, mostly background)

```bash
cd ~/Downloads/lanstackai
./scripts/import-parcels.sh
```

This:
- Loops through all 254 county zips
- Unzips each
- ogr2ogr's the shapefile into `parcels_tx`
- Logs progress per county

You'll see lines like:
```
[1/254] FIPS 48001 · ✓ imported in 12s
[2/254] FIPS 48003 · ✓ imported in 8s
...
```

Frio (FIPS 48163) should take ~5 seconds. Bexar (FIPS 48029) is the biggest at ~5 min.

**Total expected time: 60-90 min.** Go do something else. The script is resumable — if you Ctrl-C and re-run, it skips already-imported counties.

When done, sanity-check the row count:
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM parcels_tx;"
# Expected: ~14,000,000
```

---

## Step 3: Test the search function (5 min)

Verify the function returns the expected shape with real data:

```bash
psql "$SUPABASE_DB_URL" -c "
SELECT jsonb_pretty(
  search_parcels_by_owner('Wesla Ranches', 'Frio')
);
"
```

Should return a GeoJSON FeatureCollection with at least 1 feature matching Wesla Ranches LLC.

Test the autoLocate-critical queries:
```bash
for query in "Mikulencak Williamson" "Wesla Ranches Frio" "Bagan Gillespie"; do
  q=$(echo $query | awk '{$NF=""; print $0}')
  c=$(echo $query | awk '{print $NF}')
  echo "=== $q in $c ==="
  psql "$SUPABASE_DB_URL" -c "
    SELECT
      jsonb_array_length((search_parcels_by_owner('$q', '$c'))->'features') AS hits;
  "
done
```

Expected: each query returns ≥1 hit.

---

## Step 4: Swap the endpoint (5 min)

Replace the live route with the new Supabase-backed one:

```bash
cd ~/Downloads/lanstackai
cp scripts/parcels-by-owner.new.ts src/app/api/parcels-by-owner/route.ts
```

Check the diff:
```bash
git diff src/app/api/parcels-by-owner/route.ts
```

Should show: old TxGIO logic removed, new Supabase RPC call added. About 100 lines net deletion (the TxGIO route was longer due to retry logic and tokenization in TypeScript that's now in the Postgres function).

---

## Step 5: Validate against the existing fixture suite (15 min)

Start the dev server:
```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL npm run dev
```
(The env unset is the Anthropic SDK fix from the 06-18 session — won't go away until we change shells.)

Run the orchestrator E2E:
```bash
HARNESS_BASE_URL=http://localhost:3000 node scripts/test-orchestrator-e2e.mjs
```

**Expected:** All assertions pass (Thorndale 6 comps, Fritz Farm 1 comp, all coords + thumbnails + evidence_pages).

Run the Frio Farms batch validation:
```bash
HARNESS_BASE_URL=http://localhost:3000 node scripts/batch-validate-frio-claude.mjs
```

**Expected:** 12/12 pass with same `parcel_id`s as the pre-change baseline (compare to last week's known-good run).

If anything fails: **don't push**. Diagnose, fix, re-validate. The TxGIO route is still live in production — the validation has to be clean before swap.

---

## Step 6: Show me (or yourself) the diff before push

```bash
git status
git diff
```

What you should see:
- `src/app/api/parcels-by-owner/route.ts` — replaced (TxGIO → Supabase RPC)
- `supabase/migrations/040_parcels_tx_foundation.sql` — new
- `supabase/migrations/041_parcels_search_function.sql` — new
- `scripts/import-parcels.sh` — new
- `scripts/parcels-by-owner.new.ts` — delete this (it was a staging file)

```bash
rm scripts/parcels-by-owner.new.ts
```

---

## Step 7: Push

```bash
git add -A
git commit -m "Parcels foundation: self-host StratMap 2025 parcels in Supabase

Replaces /api/parcels-by-owner's TxGIO live-API dependency with
self-hosted parcel data. Same query shape, same response shape,
same downstream autoLocate behavior — but sub-second instead of
30-60+ seconds, and never depends on TxGIO uptime.

[expand with details from the session]"
git push origin main
```

Vercel auto-deploys in ~2 min.

---

## Step 8: Production smoke test (5 min)

After Vercel deploys:

1. Hard refresh `lanstackai.vercel.app/dashboard/import`
2. Upload one of Christina's Frio Farms PDFs
3. Watch the verification card render with:
   - Comp data extracted (Claude path unchanged)
   - Thumbnail attached (ConvertAPI path unchanged)
   - Auto-located parcel polygon drawn on the map ← NEW: comes from Supabase now

If polygon appears: foundation is live.
If it doesn't: revert via Vercel "Promote previous deployment" while I debug.

---

## What we deferred (separate sessions)

- Re-locate Christina's 3 bad-coord comps (Haile/Glass/Winchell saved with wrong lat/lng yesterday)
- Card UI redesign (one aerial thumbnail + clickable right panel)
- Source-pages PDF feature
- FEMA flood layer
- Terrain layer
- City limits layer
- landstack.ai custom domain DNS

Each of those is its own focused session, ordered by business value. Don't tackle any of them before the foundation is stable for a few days.

---

## Refresh schedule

StratMap publishes a new parcel snapshot each summer. Plan to refresh:

- Around August/September each year
- Same process: download fresh zips → drop & recreate `parcels_tx` (or load to `parcels_tx_2026` and atomic-rename)
- Validate against the same fixture suite before swapping in production

If the schema changes between vintages, the import script will fail loudly. We adjust the migration and proceed.
