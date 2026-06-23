#!/usr/bin/env python3
"""
DBF schema probe — reads each county zip's DBF header and reports
field-name mismatches against COLUMN_MAP in import-parcels.py.

Why this exists:
    COLUMN_MAP was modeled after Frio County's DBF. If other counties use
    different field names (e.g. PROP_ID vs PropID), our import will silently
    miss data. This script catches the mismatch BEFORE we commit to a
    statewide import.

What it tells us:
    - Schema variants across counties (1 = uniform, >1 = risk)
    - Which counties are missing critical fields
    - Which counties have extra fields we don't capture (data we'd lose)
    - Which counties' zips can't be read at all

Run:
    cd ~/Downloads/lanstackai
    python3 scripts/probe-dbf-schemas.py
    python3 scripts/probe-dbf-schemas.py --verbose   # per-county detail
"""

import os
import sys
import zipfile
import tempfile
import shutil
from pathlib import Path
from collections import Counter

import shapefile  # pyshp

ZIPS_DIR = Path('/Users/louieswope/Downloads/lanstackai/data/parcels-2025/zips')

# Keep this in sync with COLUMN_MAP in import-parcels.py.
EXPECTED_FIELDS = {
    'Prop_ID', 'GEO_ID', 'OWNER_NAME', 'NAME_CARE', 'LEGAL_AREA',
    'LGL_AREA_U', 'GIS_AREA', 'GIS_AREA_U', 'LEGAL_DESC', 'STAT_LAND_',
    'LOC_LAND_U', 'LAND_VALUE', 'IMP_VALUE', 'MKT_VALUE', 'SITUS_ADDR',
    'SITUS_NUM', 'SITUS_STRE', 'SITUS_ST_1', 'SITUS_ST_2', 'SITUS_CITY',
    'SITUS_STAT', 'SITUS_ZIP', 'MAIL_ADDR', 'MAIL_LINE1', 'MAIL_LINE2',
    'MAIL_CITY', 'MAIL_STAT', 'MAIL_ZIP', 'SOURCE', 'DATE_ACQ',
    'FIPS', 'COUNTY', 'TAX_YEAR', 'YEAR_BUILT', 'OBJECTID_1',
}

# Without these, the row is unusable in autoLocate / owner search.
CRITICAL_FIELDS = {'Prop_ID', 'OWNER_NAME', 'FIPS', 'COUNTY'}


def get_dbf_fields(zip_path):
    """Extract just the shapefile triplet, return DBF field names."""
    tmpdir = tempfile.mkdtemp(prefix='probe-')
    try:
        with zipfile.ZipFile(zip_path) as z:
            for name in z.namelist():
                # Only extract files we need for header read (saves time)
                if name.endswith(('.dbf', '.shp', '.shx')):
                    z.extract(name, tmpdir)

        shp_path = None
        for root, _dirs, files in os.walk(tmpdir):
            for f in files:
                if f.endswith('.shp'):
                    shp_path = os.path.join(root, f)
                    break
            if shp_path:
                break
        if not shp_path:
            return None, 'no .shp in zip'

        sf = shapefile.Reader(shp_path, encoding='latin-1')
        # sf.fields = [(name, type, length, decimal), ...]
        # First entry is the DeletionFlag pseudo-field, skip it.
        fields = [f[0] for f in sf.fields[1:]]
        return fields, None
    except Exception as e:
        return None, str(e)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def extract_fips(zip_name):
    parts = zip_name.split('_')
    return next((p for p in parts if p.isdigit() and len(p) == 5), zip_name)


def main():
    verbose = '--verbose' in sys.argv

    zips = sorted(ZIPS_DIR.glob('*.zip'))
    if not zips:
        print(f'No zips found in {ZIPS_DIR}')
        sys.exit(1)
    print(f'Probing {len(zips)} county zip(s)...\n')

    field_frequency = Counter()
    counties_missing_critical = []
    schema_variants = {}  # tuple(sorted fields) -> list of FIPS
    failed = []

    for zip_path in zips:
        fips = extract_fips(zip_path.name)
        fields, err = get_dbf_fields(zip_path)
        if err:
            failed.append((fips, err))
            continue

        for f in fields:
            field_frequency[f] += 1

        schema_key = tuple(sorted(fields))
        schema_variants.setdefault(schema_key, []).append(fips)

        missing_critical = CRITICAL_FIELDS - set(fields)
        if missing_critical:
            counties_missing_critical.append((fips, sorted(missing_critical)))

        if verbose:
            print(f'  {fips}: {len(fields)} fields')

    total = len(zips)
    print(f'\n{"═" * 70}')
    print(f'  Probed:                    {total} counties')
    print(f'  Failed to read:            {len(failed)}')
    print(f'  Distinct schema variants:  {len(schema_variants)}')
    print(f'  Missing critical fields:   {len(counties_missing_critical)}')
    print(f'{"═" * 70}\n')

    # Schema variants — 1 variant across all 254 = green light. >1 = inspect.
    print('SCHEMA VARIANTS (sorted by # counties using each):')
    variants_sorted = sorted(schema_variants.items(), key=lambda x: -len(x[1]))
    for i, (schema_key, fips_list) in enumerate(variants_sorted, 1):
        print(f'\n  Variant {i}: {len(fips_list)} counties')
        print(f'    Sample FIPS: {fips_list[:5]}{"..." if len(fips_list) > 5 else ""}')
        missing = sorted(EXPECTED_FIELDS - set(schema_key))
        extra = sorted(set(schema_key) - EXPECTED_FIELDS)
        if missing:
            print(f'    Missing from COLUMN_MAP:  {missing}')
        if extra:
            print(f'    Extra fields not mapped:  {extra}')
        if not missing and not extra:
            print(f'    ✓ Exact match with COLUMN_MAP')

    # Field frequency — which expected fields show up in which % of counties.
    print('\nEXPECTED FIELD FREQUENCY (how many counties have each):')
    for f in sorted(EXPECTED_FIELDS):
        count = field_frequency.get(f, 0)
        pct = count * 100 // total
        bar = '█' * (count * 40 // total)
        marker = '✓' if count == total else '⚠' if count > total * 0.9 else '✗'
        print(f'  {marker} {f:15s} {bar:40s} {count:>3d}/{total} ({pct}%)')

    # Fields seen in DBFs but not in our COLUMN_MAP — data we'd silently drop.
    unexpected = {f: c for f, c in field_frequency.items() if f not in EXPECTED_FIELDS}
    if unexpected:
        print('\nFIELDS PRESENT IN COUNTIES BUT NOT IN COLUMN_MAP:')
        print('(If frequent, consider adding to COLUMN_MAP before import.)')
        for f, c in sorted(unexpected.items(), key=lambda x: -x[1]):
            print(f'  {f:25s} present in {c:>3d}/{total} counties')

    if counties_missing_critical:
        print(f'\n⚠ COUNTIES MISSING CRITICAL FIELDS:')
        for fips, missing in counties_missing_critical:
            print(f'  {fips}: missing {missing}')
    else:
        print(f'\n✓ All readable counties have critical fields '
              f'({sorted(CRITICAL_FIELDS)})')

    if failed:
        print(f'\n✗ FAILED TO READ:')
        for fips, err in failed:
            print(f'  {fips}: {err}')


if __name__ == '__main__':
    main()
