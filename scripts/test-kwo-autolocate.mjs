#!/usr/bin/env node
//
// Diagnose why KWO Ranches isn't auto-mapping.
// Queries TxGIO statewide parcel layer with KWO's exact inputs and
// reports what autoLocate would actually see at each step.

const TXGIO =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

const KWO = {
  lat: 30.47100067,
  lng: -97.21630096,
  county: 'Williamson',
  acres: 73.62,
  grantor: 'KWO Ranches LLC',
  grantee: 'Irene & Danny Mikulencak',
};

function fmt(p) {
  return `prop_id=${p.prop_id} · owner="${p.owner_name}" · ${(+p.gis_area || 0).toFixed(2)}ac · county=${p.county}`;
}

async function pointQuery(lat, lng) {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'false',
    f: 'geojson',
  });
  const r = await fetch(`${TXGIO}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).features ?? [];
}

async function whereQuery(where, limit = 50) {
  const params = new URLSearchParams({
    where,
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'false',
    resultRecordCount: String(limit),
    f: 'geojson',
  });
  const r = await fetch(`${TXGIO}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).features ?? [];
}

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`KWO Ranches autoLocate trace`);
console.log(`  Subject: ${KWO.county} County · ${KWO.acres} ac`);
console.log(`  Lat/lng: ${KWO.lat}, ${KWO.lng}`);
console.log(`  Grantor: "${KWO.grantor}" · Grantee: "${KWO.grantee}"`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// ─── Step 1: point-in-polygon seed ───────────────────────────────────────
console.log(`STEP 1 · Point-in-polygon at the appraiser's lat/lng`);
const t1 = Date.now();
const seed = await pointQuery(KWO.lat, KWO.lng);
const t1elapsed = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`  TxGIO returned ${seed.length} parcel(s) in ${t1elapsed}s\n`);
for (const f of seed) console.log(`    → ${fmt(f.properties)}`);

if (seed.length === 0) {
  console.log(`\n  ⚠️ NOTHING at that point. autoLocate seed path FAILS here.\n`);
} else {
  const p = seed[0].properties;
  const owner = String(p.owner_name || '').toUpperCase();
  const grantorMatch = ['KWO', 'RANCHES'].every((t) => owner.includes(t));
  const granteeMatch =
    owner.includes('MIKULENCAK') || (owner.includes('IRENE') && owner.includes('DANNY'));
  const acresDelta = Math.abs((+p.gis_area || 0) - KWO.acres) / KWO.acres;

  console.log(`\n  Corroboration check:`);
  console.log(`    owner matches grantor "KWO RANCHES"? ${grantorMatch ? '✓' : '✗'}`);
  console.log(`    owner matches grantee "MIKULENCAK"? ${granteeMatch ? '✓' : '✗'}`);
  console.log(`    acres ${(+p.gis_area || 0).toFixed(2)} vs target ${KWO.acres} → Δ ${(acresDelta * 100).toFixed(1)}% ${acresDelta <= 0.15 ? '✓' : '✗'}`);

  if (grantorMatch || granteeMatch || acresDelta <= 0.15) {
    console.log(`\n  ✓ SEED CORROBORATED. autoLocate would return this with confidence.`);
  } else {
    console.log(`\n  ✗ SEED DROPPED. autoLocate falls through to owner search.`);
  }
}

// ─── Step 2: county + acreage query ──────────────────────────────────────
console.log(`\n\nSTEP 2 · Williamson County + acres 62-85 (target ±15%)`);
const t2 = Date.now();
const range = await whereQuery(
  `(UPPER(county) = 'WILLIAMSON' OR UPPER(county) = 'WILLIAMSON COUNTY') AND gis_area BETWEEN 62 AND 85`,
  200,
);
const t2elapsed = ((Date.now() - t2) / 1000).toFixed(1);
console.log(`  TxGIO returned ${range.length} parcel(s) in ${t2elapsed}s`);

// ─── Step 3: owner search "Mikulencak" ───────────────────────────────────
console.log(`\n\nSTEP 3 · Owner search "MIKULENCAK" in Williamson`);
const t3 = Date.now();
const mik = await whereQuery(
  `(UPPER(county) = 'WILLIAMSON' OR UPPER(county) = 'WILLIAMSON COUNTY') AND UPPER(owner_name) LIKE '%MIKULENCAK%'`,
  50,
);
console.log(`  ${mik.length} matches in ${((Date.now() - t3) / 1000).toFixed(1)}s\n`);
for (const f of mik.slice(0, 10)) console.log(`    → ${fmt(f.properties)}`);

// ─── Step 4: owner search "KWO" ──────────────────────────────────────────
console.log(`\n\nSTEP 4 · Owner search "KWO" in Williamson`);
const t4 = Date.now();
const kwo = await whereQuery(
  `(UPPER(county) = 'WILLIAMSON' OR UPPER(county) = 'WILLIAMSON COUNTY') AND UPPER(owner_name) LIKE '%KWO%'`,
  50,
);
console.log(`  ${kwo.length} matches in ${((Date.now() - t4) / 1000).toFixed(1)}s\n`);
for (const f of kwo.slice(0, 10)) console.log(`    → ${fmt(f.properties)}`);

// ─── Step 5: bbox query around the lat/lng ───────────────────────────────
console.log(`\n\nSTEP 5 · 1-mile bbox around (${KWO.lat}, ${KWO.lng})`);
const dLat = 1 / 69;
const dLng = 1 / 60;
const bbox = `${KWO.lng - dLng},${KWO.lat - dLat},${KWO.lng + dLng},${KWO.lat + dLat}`;
const params = new URLSearchParams({
  geometry: bbox,
  geometryType: 'esriGeometryEnvelope',
  inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  outFields: 'prop_id,owner_name,gis_area,county',
  returnGeometry: 'false',
  resultRecordCount: '500',
  f: 'geojson',
});
const t5 = Date.now();
const r = await fetch(`${TXGIO}?${params}`);
const bboxRes = r.ok ? (await r.json()).features ?? [] : [];
console.log(`  ${bboxRes.length} parcels within ~1mi in ${((Date.now() - t5) / 1000).toFixed(1)}s`);

const candidates = bboxRes.filter((f) => {
  const owner = String(f.properties.owner_name || '').toUpperCase();
  const acres = +f.properties.gis_area || 0;
  const acreMatch = Math.abs(acres - KWO.acres) / KWO.acres <= 0.20;
  const ownerMatch =
    owner.includes('MIKULENCAK') ||
    owner.includes('KWO') ||
    (owner.includes('IRENE') && (owner.includes('DANIEL') || owner.includes('DANNY')));
  return acreMatch || ownerMatch;
});
console.log(`  Of those, ${candidates.length} match KWO either by owner or acreage:`);
for (const f of candidates.slice(0, 10)) console.log(`    → ${fmt(f.properties)}`);

console.log(`\n═══════════════════════════════════════════════════════════════════\n`);
