import { NextRequest, NextResponse } from 'next/server';
import { autoLocateFromMetadata } from '@/lib/utils/autoLocate';

/**
 * GET /api/health/test-autolocate?county=Frio&acres=318&grantee=Lindsey+Jesse&grantor=...
 *
 * No-auth diagnostic that runs autoLocateFromMetadata with the given test
 * comp and returns the full result. Used to debug auto-locate failures
 * without needing to actually import a PDF.
 *
 * Captures console output so we can see which phase fired.
 */

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const county = searchParams.get('county') || 'Frio';
  const acresStr = searchParams.get('acres') || '318';
  const acres = parseFloat(acresStr);
  const grantee = searchParams.get('grantee') || null;
  const grantor = searchParams.get('grantor') || null;
  const property_name = searchParams.get('property_name') || null;
  const description = searchParams.get('description') || null;
  const address = searchParams.get('address') || null;

  // Capture all console.log output so we can return the trace
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => {
    logs.push('LOG: ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    originalLog(...args);
  };
  console.warn = (...args: any[]) => {
    logs.push('WARN: ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    originalWarn(...args);
  };

  const t0 = Date.now();
  let result: any = null;
  let errorMsg: string | null = null;
  try {
    result = await autoLocateFromMetadata({
      county,
      acres,
      grantee,
      grantor,
      property_name,
      description,
      address,
      aerialImage: null,
    });
  } catch (e: any) {
    errorMsg = e?.message || String(e);
  }
  const elapsed = Date.now() - t0;

  console.log = originalLog;
  console.warn = originalWarn;

  return NextResponse.json({
    input: {
      county,
      acres,
      grantee,
      grantor,
      property_name,
      description: description?.slice(0, 100),
      address,
    },
    flags: {
      owner_search_first: process.env.OWNER_SEARCH_FIRST === '1',
    },
    elapsed_ms: elapsed,
    result: result ? {
      latitude: result.latitude,
      longitude: result.longitude,
      parcel_id: result.parcel_id,
      match_confidence: result.match_confidence,
      match_reason: result.match_reason,
      has_geometry: Boolean(result.boundary_geojson),
    } : null,
    error: errorMsg,
    logs: logs.slice(0, 100), // first 100 log lines should cover any path
  }, { headers: { 'Cache-Control': 'no-store' } });
}
