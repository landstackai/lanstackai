#!/usr/bin/env node
//
// Validation: confirm normalizeParcelFeature computes valid acreage
// for the Williamson parcels that TxGIO returns with gis_area=0.

import * as turf from '@turf/turf';

const TXGIO =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';
const SQ_METERS_PER_ACRE = 4046.8564224;

// Inline copy of the helper so the test doesn't need to import the TS module.
function normalizeParcelFeature(feature) {
  if (!feature || !feature.properties || !feature.geometry) return feature;
  const stated = +feature.properties.gis_area || 0;
  if (stated > 0) return feature;
  try {
    const acres = turf.area(feature) / SQ_METERS_PER_ACRE;
    if (!Number.isFinite(acres) || acres <= 0) return feature;
    return {
      ...feature,
      properties: { ...feature.properties, gis_area: acres, _gis_area_computed: true },
    };
  } catch {
    return feature;
  }
}

async function pointQuery(lat, lng) {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  const r = await fetch(`${TXGIO}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).features ?? [];
}

async function ownerQuery(owner, county) {
  const params = new URLSearchParams({
    where: `(UPPER(county) = '${county.toUpperCase()}' OR UPPER(county) = '${county.toUpperCase()} COUNTY') AND UPPER(owner_name) LIKE '%${owner.toUpperCase()}%'`,
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '50',
    f: 'geojson',
  });
  const r = await fetch(`${TXGIO}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).features ?? [];
}

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`KWO Ranches autoLocate (WITH normalizeParcelFeature fallback)`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

const KWO = {
  lat: 30.47100067,
  lng: -97.21630096,
  target_acres: 73.62,
  grantor: 'KWO Ranches LLC',
  grantee: 'Irene & Danny Mikulencak',
  county: 'Williamson',
};

// ── STEP 1: seed parcel ──────────────────────────────────────────────────
console.log(`STEP 1 · Point-in-polygon at (${KWO.lat}, ${KWO.lng})`);
const seedRaw = await pointQuery(KWO.lat, KWO.lng);
const seed = seedRaw.map(normalizeParcelFeature);
console.log(`  TxGIO returned ${seed.length} parcel(s)\n`);
for (const f of seed) {
  const p = f.properties;
  console.log(
    `    → prop_id=${p.prop_id} · owner="${p.owner_name}" · ${(+p.gis_area).toFixed(2)} ac` +
      `${p._gis_area_computed ? ' [COMPUTED]' : ''}`,
  );
}

if (seed.length > 0) {
  const p = seed[0].properties;
  const owner = String(p.owner_name || '').toUpperCase();
  const granteeMatch =
    owner.includes('MIKULENCAK') || (owner.includes('IRENE') && (owner.includes('DANNY') || owner.includes('DANIEL')));
  const acresDelta = Math.abs((+p.gis_area || 0) - KWO.target_acres) / KWO.target_acres;
  console.log(`\n  Corroboration check:`);
  console.log(`    owner matches grantee "MIKULENCAK"?  ${granteeMatch ? '✓' : '✗'}`);
  console.log(`    acres ${(+p.gis_area).toFixed(2)} vs target ${KWO.target_acres} → Δ ${(acresDelta * 100).toFixed(1)}% ${acresDelta <= 0.15 ? '✓' : '✗'}`);

  if (granteeMatch && acresDelta <= 0.05) {
    console.log(`\n  ✓✓ HIGH CONFIDENCE: owner + acres both match within 5%.`);
  } else if (granteeMatch || acresDelta <= 0.15) {
    console.log(`\n  ✓ MEDIUM CONFIDENCE: at least one signal corroborates.`);
  } else {
    console.log(`\n  ✗ Falls through to owner search.`);
  }
}

// ── STEP 2: owner search → cluster ───────────────────────────────────────
console.log(`\n\nSTEP 2 · Owner search "MIKULENCAK" in Williamson, then normalize`);
const ownerRaw = await ownerQuery('Mikulencak', KWO.county);
const ownerFeatures = ownerRaw.map(normalizeParcelFeature);
console.log(`  ${ownerFeatures.length} parcels (all normalized)\n`);

let validCount = 0;
let inRange = 0;
for (const f of ownerFeatures.slice(0, 15)) {
  const p = f.properties;
  const acres = +p.gis_area;
  if (acres > 0) validCount++;
  if (acres >= KWO.target_acres * 0.85 && acres <= KWO.target_acres * 1.15) inRange++;
  console.log(
    `    → ${p.prop_id} · "${p.owner_name}" · ${acres.toFixed(2)} ac` +
      `${p._gis_area_computed ? ' [COMPUTED]' : ''}` +
      `${acres >= KWO.target_acres * 0.85 && acres <= KWO.target_acres * 1.15 ? ' ← in target range' : ''}`,
  );
}

const totalInRange = ownerFeatures.filter((f) => {
  const a = +f.properties.gis_area || 0;
  return a >= KWO.target_acres * 0.85 && a <= KWO.target_acres * 1.15;
}).length;

console.log(`\n  Total parcels with valid (>0) acres: ${validCount} / ${ownerFeatures.length}`);
console.log(`  Parcels in target acreage range (62-85): ${totalInRange}`);

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`Expected outcome: seed parcel corroborates via owner+acres, KWO`);
console.log(`auto-maps with the parcel boundary drawn.`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);
