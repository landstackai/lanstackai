import { NextRequest, NextResponse } from 'next/server';
import { getCountyParcels, getCountySource } from '@/lib/utils/countyParcels';

export const revalidate = 86400;

export async function GET(
  _req: NextRequest,
  { params }: { params: { county: string } }
) {
  const key = (params.county || '').toLowerCase();
  if (!getCountySource(key)) {
    return NextResponse.json({ error: `Unknown county: ${key}` }, { status: 404 });
  }
  try {
    const data = await getCountyParcels(key);
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/geo+json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Fetch failed' }, { status: 502 });
  }
}
