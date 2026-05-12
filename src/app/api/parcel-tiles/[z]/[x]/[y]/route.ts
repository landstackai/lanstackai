import { NextRequest, NextResponse } from 'next/server';

const REGRID_TOKEN = process.env.REGRID_API_KEY;

export async function GET(
  _req: NextRequest,
  { params }: { params: { z: string; x: string; y: string } }
) {
  if (!REGRID_TOKEN) {
    return new NextResponse(null, { status: 204 });
  }

  const { z, x, y } = params;
  const yClean = y.replace(/\.(mvt|pbf)$/, '');
  const url = `https://tiles.regrid.com/api/v1/parcels/${z}/${x}/${yClean}.mvt?token=${REGRID_TOKEN}`;

  const upstream = await fetch(url);
  if (upstream.status === 204 || !upstream.ok) {
    return new NextResponse(null, { status: upstream.status === 204 ? 204 : 502 });
  }

  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
