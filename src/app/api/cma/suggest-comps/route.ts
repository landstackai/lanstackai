import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// @ts-expect-error — turf v6.5 .d.ts not exposed
import * as turf from '@turf/turf';

// Suggest the best N comps for a CMA subject. Scoring blends:
//   - proximity (closer is better, up to ~50 mi)
//   - acreage similarity (within ~50% of subject)
//   - recency (sale within 2 years)
//   - county / state match (bonus)
//   - feature match (water, road, dev, ag) when subject preferences supplied
//
// Body:
// {
//   subject: { latitude, longitude, county, state, acres,
//              water?, road_frontage?, dev_potential? },
//   limit?: number (default 8, max 20),
//   exclude_ids?: string[]  // already-selected comp ids
// }
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const subject = body?.subject || {};
  const limit = Math.min(20, Math.max(1, body?.limit || 8));
  const excludeIds: string[] = Array.isArray(body?.exclude_ids) ? body.exclude_ids : [];

  if (subject.latitude == null || subject.longitude == null || !subject.acres) {
    return NextResponse.json(
      { error: 'subject lat/lng + acres required' },
      { status: 400 }
    );
  }

  // Fetch all comps the user can see (RLS handles visibility)
  const { data: comps, error } = await supabase
    .from('comps')
    .select('id,property_name,county,state,acres,sale_price,price_per_acre,ppa_land_only,sale_date,latitude,longitude,water,road_frontage,dev_potential,has_improvements,description,status')
    .eq('status', 'Sold');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const subjPt = turf.point([subject.longitude, subject.latitude]);
  const today = Date.now();
  const TWO_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 2;

  type Scored = { comp: any; score: number; distance_mi: number; reasons: string[] };
  const scored: Scored[] = [];

  for (const c of comps || []) {
    if (excludeIds.includes(c.id)) continue;
    if (c.latitude == null || c.longitude == null || !c.acres) continue;

    const reasons: string[] = [];
    const distMi = turf.distance(subjPt, turf.point([c.longitude, c.latitude]), { units: 'miles' });

    // Hard cutoff at 100 miles — beyond that, not a useful comp
    if (distMi > 100) continue;

    // Proximity: 1.0 at 0 mi, 0.0 at 100 mi
    const proximity = Math.max(0, 1 - distMi / 100);

    // Acreage similarity: 1.0 when ratio is exactly 1, falls off symmetrically
    const ratio = Math.min(c.acres, subject.acres) / Math.max(c.acres, subject.acres);
    const acreFit = ratio; // 0..1, 1 = identical size

    // Recency: 1.0 if within 6 mo, fades to 0 by 2 yrs
    let recency = 0;
    if (c.sale_date) {
      const ageMs = today - new Date(c.sale_date).getTime();
      if (ageMs >= 0 && ageMs <= TWO_YEARS_MS) {
        recency = 1 - ageMs / TWO_YEARS_MS;
      }
    }

    // County / state bonuses
    let geoBonus = 0;
    if (subject.county && c.county && c.county.toLowerCase() === String(subject.county).toLowerCase()) {
      geoBonus += 0.2;
      reasons.push('same county');
    }
    if (subject.state && c.state && c.state.toUpperCase() === String(subject.state).toUpperCase()) {
      geoBonus += 0.05;
    }

    // Feature match
    let featureBonus = 0;
    if (subject.water && c.water === subject.water) {
      featureBonus += 0.1;
      reasons.push(`water match (${c.water})`);
    }
    if (subject.road_frontage && c.road_frontage === subject.road_frontage) {
      featureBonus += 0.05;
    }
    if (subject.dev_potential && c.dev_potential === subject.dev_potential) {
      featureBonus += 0.05;
    }

    // Composite (weights chosen so a perfect match ~ 1.0; geo/feature bonuses
    // can push past 1 if all align)
    const score =
      proximity * 0.45 +
      acreFit * 0.35 +
      recency * 0.20 +
      geoBonus +
      featureBonus;

    if (acreFit > 0.4) reasons.push(`${(ratio * 100).toFixed(0)}% size match`);
    if (recency > 0) reasons.push(`sold ${Math.round((today - new Date(c.sale_date).getTime()) / (1000 * 60 * 60 * 24))} days ago`);
    reasons.push(`${distMi.toFixed(1)} mi away`);

    scored.push({ comp: c, score, distance_mi: distMi, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  return NextResponse.json({
    suggestions: top.map((s) => ({
      id: s.comp.id,
      property_name: s.comp.property_name,
      county: s.comp.county,
      acres: s.comp.acres,
      sale_price: s.comp.sale_price,
      ppa: s.comp.ppa_land_only || s.comp.price_per_acre || 0,
      distance_mi: Number(s.distance_mi.toFixed(1)),
      score: Number(s.score.toFixed(3)),
      reasons: s.reasons.slice(0, 3),
    })),
    total_candidates: comps?.length || 0,
  });
}
