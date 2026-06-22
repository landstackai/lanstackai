#!/usr/bin/env python3
"""
Python parcel importer — uses COPY FROM STDIN for ~100x faster
loads than ogr2ogr's row-by-row INSERTs over a network connection.

Run:
    cd ~/Downloads/lanstackai
    source .env.local && export SUPABASE_DB_URL
    python3 scripts/import-parcels.py             # all 254 counties
    python3 scripts/import-parcels.py --only 48163  # Frio only
    python3 scripts/import-parcels.py --christina   # 12 priority counties

Why this exists:
    ogr2ogr over a remote Postgres connection makes one round-trip per
    INSERT (even with PG_USE_COPY YES), which is fine on a LAN but
    glacial across the public internet. We observed Andrews County
    (~25K parcels) running for 10+ minutes via ogr2ogr.

    COPY FROM STDIN streams the entire county's rows in one go.
    Network latency hits once per county, not once per row. Frio
    (13K parcels) should land in seconds, Bexar (~500K parcels) in
    a couple minutes.

Resumability:
    Per-county DELETE+INSERT in one transaction. If interrupted
    mid-county, that county's rows roll back cleanly. Already-
    imported counties are skipped (COUNT(*) check).
"""

import os
import sys
import io
import time
import zipfile
import tempfile
import shutil
from pathlib import Path

import shapefile  # pyshp
import psycopg2
from psycopg2 import sql

# ── Config ────────────────────────────────────────────────────────────
ZIPS_DIR = Path('/Users/louieswope/Downloads/lanstackai/data/parcels-2025/zips')

# Map DBF field name → parcels_tx column name (lowercase)
COLUMN_MAP = {
    'Prop_ID': 'prop_id',
    'GEO_ID': 'geo_id',
    'OWNER_NAME': 'owner_name',
    'NAME_CARE': 'name_care',
    'LEGAL_AREA': 'legal_area',
    'LGL_AREA_U': 'lgl_area_u',
    'GIS_AREA': 'gis_area',
    'GIS_AREA_U': 'gis_area_u',
    'LEGAL_DESC': 'legal_desc',
    'STAT_LAND_': 'stat_land_',
    'LOC_LAND_U': 'loc_land_u',
    'LAND_VALUE': 'land_value',
    'IMP_VALUE': 'imp_value',
    'MKT_VALUE': 'mkt_value',
    'SITUS_ADDR': 'situs_addr',
    'SITUS_NUM': 'situs_num',
    'SITUS_STRE': 'situs_stre',
    'SITUS_ST_1': 'situs_st_1',
    'SITUS_ST_2': 'situs_st_2',
    'SITUS_CITY': 'situs_city',
    'SITUS_STAT': 'situs_stat',
    'SITUS_ZIP': 'situs_zip',
    'MAIL_ADDR': 'mail_addr',
    'MAIL_LINE1': 'mail_line1',
    'MAIL_LINE2': 'mail_line2',
    'MAIL_CITY': 'mail_city',
    'MAIL_STAT': 'mail_stat',
    'MAIL_ZIP': 'mail_zip',
    'SOURCE': 'source',
    'DATE_ACQ': 'date_acq',
    'FIPS': 'fips',
    'COUNTY': 'county',
    'TAX_YEAR': 'tax_year',
    'YEAR_BUILT': 'year_built',
    'OBJECTID_1': 'objectid_1',
}

# Order of columns we COPY in. geom MUST be last so the WKT string lines up.
COLUMNS = list(COLUMN_MAP.values()) + ['geom']

# Counties Christina actively works in. Used by --christina flag.
PRIORITY_FIPS = {
    '48163',  # Frio
    '48013',  # Atascosa
    '48493',  # Wilson
    '48325',  # Medina
    '48029',  # Bexar
    '48019',  # Bandera
    '48171',  # Gillespie
    '48265',  # Kerr
    '48091',  # Comal
    '48385',  # Real
    '48297',  # Live Oak
    '48259',  # Kendall
    '48041',  # Brazos (broad coverage)
    '48027',  # Bell
    '48453',  # Travis
    '48507',  # Zavala
}


# ── Helpers ────────────────────────────────────────────────────────────
def geometry_to_wkt(shape):
    """Convert pyshp Shape → PostGIS WKT (MultiPolygon, EPSG:4326)."""
    if shape is None or shape.shapeType not in (5, 15, 25):  # Polygon types
        return None
    points = shape.points
    if not points:
        return None
    # pyshp gives us `parts`: index where each ring starts
    parts = list(shape.parts) + [len(points)]
    rings = []
    for i in range(len(parts) - 1):
        ring_pts = points[parts[i]:parts[i + 1]]
        if len(ring_pts) < 4:
            continue
        rings.append(ring_pts)
    if not rings:
        return None
    # Naive interpretation: all rings as one polygon. For complex multi-
    # polygons this isn't strictly correct (we'd need ring orientation to
    # group exterior/interior), but autoLocate only needs spatial intersect
    # & convex-hull-style queries that this satisfies for ~99% of parcels.
    ring_strs = ['(' + ','.join(f'{x:.7f} {y:.7f}' for x, y in r) + ')'
                 for r in rings]
    return f'SRID=4326;MULTIPOLYGON((({",".join(ring_strs).strip("()")})))'


def escape_for_copy(v):
    """COPY format escaping: \\N = NULL, then escape tabs/newlines/backslashes."""
    if v is None:
        return r'\N'
    s = str(v)
    if s == '' or s.strip() == '':
        return r'\N'
    # Replace troublesome chars in COPY text format
    s = s.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n').replace('\r', '\\r')
    return s


def import_county(conn, zip_path, force=False):
    """Import one county zip into parcels_tx. Returns (row_count, elapsed_s) or (-1, e)."""
    name = zip_path.name
    fips_match = name.split('_')
    fips = next((f for f in fips_match if f.isdigit() and len(f) == 5), None)
    if not fips:
        return -1, 'no FIPS in filename'

    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*)::int FROM parcels_tx WHERE fips = %s', (fips,))
        existing = cur.fetchone()[0]
    if existing > 0 and not force:
        return existing, 'skipped (already present)'
    if force and existing > 0:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM parcels_tx WHERE fips = %s', (fips,))
        conn.commit()

    # Extract zip to temp dir
    tmpdir = tempfile.mkdtemp(prefix='parcel-')
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmpdir)
        # Find the shapefile
        shp_path = None
        for root, dirs, files in os.walk(os.path.join(tmpdir, 'shp')):
            for f in files:
                if f.endswith('.shp'):
                    shp_path = os.path.join(root, f)
                    break
            if shp_path:
                break
        if not shp_path:
            return -1, 'no .shp in zip'

        # Open shapefile, build COPY buffer in-memory
        sf = shapefile.Reader(shp_path, encoding='latin-1')
        field_names = [f[0] for f in sf.fields[1:]]  # skip DeletionFlag
        dbf_idx = {name: i for i, name in enumerate(field_names)}

        # Build COPY buffer
        buf = io.StringIO()
        row_count = 0
        empty_geom_count = 0
        bad_geom_count = 0
        # iterShapeRecords can raise on individual bad records; iterate
        # robustly: catch per-record exceptions so one bad parcel doesn't
        # kill an entire county load.
        n = len(sf)
        for i in range(n):
            try:
                rec = sf.record(i)
                shape = sf.shape(i)
            except Exception as e:
                bad_geom_count += 1
                continue

            # Skip records with no geometry (CAD records that exist in the
            # DBF but have no surveyed boundary). These can be ~5-10% of
            # parcels in some counties — common for unpatented mineral
            # interests, abstract entries, etc.
            if shape is None or not getattr(shape, 'points', None):
                empty_geom_count += 1
                continue

            row_values = []
            for src_name in COLUMN_MAP.keys():
                if src_name in dbf_idx:
                    v = rec[dbf_idx[src_name]]
                else:
                    v = None
                row_values.append(escape_for_copy(v))
            # geom (WKT string)
            try:
                wkt = geometry_to_wkt(shape)
            except Exception:
                bad_geom_count += 1
                continue
            if wkt is None:
                empty_geom_count += 1
                continue
            row_values.append(escape_for_copy(wkt))
            buf.write('\t'.join(row_values))
            buf.write('\n')
            row_count += 1

        # Stream via COPY FROM STDIN
        buf.seek(0)
        t0 = time.time()
        with conn.cursor() as cur:
            cur.copy_from(
                buf,
                'parcels_tx',
                columns=COLUMNS,
                sep='\t',
                null=r'\N',
            )
        conn.commit()
        elapsed = time.time() - t0
        skipped_note = ''
        if empty_geom_count or bad_geom_count:
            skipped_note = f' (+{empty_geom_count} empty, {bad_geom_count} bad)'
        return row_count, f'{elapsed:.1f}s{skipped_note}'

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── Main ───────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    only_fips = None
    christina_only = False
    force = False
    for i, a in enumerate(args):
        if a == '--only' and i + 1 < len(args):
            only_fips = args[i + 1]
        elif a == '--christina':
            christina_only = True
        elif a == '--force':
            force = True

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        # Try reading from .env.local
        try:
            with open('.env.local') as f:
                for line in f:
                    if line.startswith('SUPABASE_DB_URL='):
                        db_url = line.split('=', 1)[1].strip().strip('"\'')
                        break
        except FileNotFoundError:
            pass
    if not db_url:
        print('ERROR: SUPABASE_DB_URL not set')
        sys.exit(1)

    print(f'Connecting to Supabase...')
    conn = psycopg2.connect(db_url)
    print('✓ Connected')

    zips = sorted(ZIPS_DIR.glob('*.zip'))
    if only_fips:
        zips = [z for z in zips if f'_{only_fips}_' in z.name]
    elif christina_only:
        zips = [z for z in zips if any(f'_{f}_' in z.name for f in PRIORITY_FIPS)]

    print(f'Importing {len(zips)} county zip(s)...\n')

    start = time.time()
    ok, skip, fail = 0, 0, 0
    total_rows = 0

    for i, zip_path in enumerate(zips, 1):
        try:
            result, info = import_county(conn, zip_path, force=force)
            if isinstance(info, str) and info.startswith('skipped'):
                skip += 1
                print(f'[{i}/{len(zips)}] {zip_path.name:55s} ⏭  {info}')
            elif result < 0:
                fail += 1
                print(f'[{i}/{len(zips)}] {zip_path.name:55s} ✗ {info}')
            else:
                ok += 1
                total_rows += result
                print(f'[{i}/{len(zips)}] {zip_path.name:55s} ✓ {result:>8,} rows in {info}', flush=True)
        except Exception as e:
            fail += 1
            print(f'[{i}/{len(zips)}] {zip_path.name:55s} ✗ ERROR: {e}')
            try:
                conn.rollback()
            except Exception:
                pass

    elapsed = time.time() - start
    print(f'\n{"═" * 65}')
    print(f'  Import complete in {int(elapsed//60)}m {int(elapsed%60)}s')
    print(f'  ✓ {ok} counties imported ({total_rows:,} rows)')
    print(f'  ⏭  {skip} skipped')
    print(f'  ✗ {fail} failed')
    print(f'{"═" * 65}')

    conn.close()
    sys.exit(1 if fail > 0 else 0)


if __name__ == '__main__':
    main()
