import { NextRequest, NextResponse } from 'next/server';

// Regrid API integration for parcel data
// Falls back to mock data if no API key configured

const REGRID_API_KEY = process.env.REGRID_API_KEY;
const REGRID_BASE = 'https://app.regrid.com/api/v2';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat');
  const lng = searchParams.get('lng');
  const parcelId = searchParams.get('parcel_id');

  if (!lat && !lng && !parcelId) {
    return NextResponse.json({ error: 'lat/lng or parcel_id required' }, { status: 400 });
  }

  // If Regrid API key is configured, use real data
  if (REGRID_API_KEY) {
    try {
      let url = '';
      if (lat && lng) {
        url = `${REGRID_BASE}/query?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`;
      } else if (parcelId) {
        url = `${REGRID_BASE}/query?parcel_id=${parcelId}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`;
      }

      const response = await fetch(url);
      const data = await response.json();

      if (data.parcels?.length > 0) {
        const parcel = data.parcels[0];
        return NextResponse.json({
          parcel_id: parcel.fields?.parno || parcel.id,
          owner_name: parcel.fields?.owner || null,
          acres: parcel.fields?.gisacre || parcel.fields?.calc_acreage || null,
          address: parcel.fields?.address || null,
          county: parcel.fields?.county || null,
          state: parcel.fields?.state_abbr || 'TX',
          latitude: parseFloat(lat || '0'),
          longitude: parseFloat(lng || '0'),
          geometry: parcel.geometry || null,
        });
      }
    } catch (error) {
      console.error('Regrid API error:', error);
    }
  }

  // Mock data for development (when no Regrid key)
  // Returns realistic Texas parcel data structure
  const mockParcel = {
    parcel_id: `TX-${Math.random().toString(36).substr(2, 8).toUpperCase()}`,
    owner_name: getMockOwner(),
    acres: Math.round((Math.random() * 500 + 50) * 10) / 10,
    address: getMockAddress(),
    county: 'Real',
    state: 'TX',
    latitude: parseFloat(lat || '30.0'),
    longitude: parseFloat(lng || '-99.5'),
    geometry: createMockPolygon(
      parseFloat(lat || '30.0'),
      parseFloat(lng || '-99.5'),
      0.02
    ),
  };

  return NextResponse.json(mockParcel);
}

function getMockOwner(): string {
  const owners = [
    'Temple Henry LLC',
    'Smith Family Ranch Trust',
    'Johnson Land Holdings',
    'Delfino C Flores',
    'HP Land Development LLC',
    'West Texas Ranch Partners',
    'Hill Country Grazing LLC',
    'Mask Kye Inc',
    'Fuller Billy',
    'Rimrock Ranch Holdings',
  ];
  return owners[Math.floor(Math.random() * owners.length)];
}

function getMockAddress(): string {
  const roads = ['Ranch Road 336', 'FM 2631', 'CR 310', 'PR 5500', 'Highway 90'];
  const road = roads[Math.floor(Math.random() * roads.length)];
  const num = Math.floor(Math.random() * 9000 + 1000);
  return `${num} ${road}`;
}

function createMockPolygon(lat: number, lng: number, size: number) {
  // Create a realistic irregular polygon around the clicked point
  const randomFactor = () => (Math.random() - 0.5) * size * 0.3;
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - size + randomFactor(), lat - size + randomFactor()],
      [lng + size + randomFactor(), lat - size + randomFactor()],
      [lng + size + randomFactor(), lat + size * 0.7 + randomFactor()],
      [lng + size * 0.3 + randomFactor(), lat + size + randomFactor()],
      [lng - size * 0.5 + randomFactor(), lat + size + randomFactor()],
      [lng - size + randomFactor(), lat + size * 0.5 + randomFactor()],
      [lng - size + randomFactor(), lat - size + randomFactor()],
    ]],
  };
}
