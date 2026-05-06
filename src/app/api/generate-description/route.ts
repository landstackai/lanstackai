import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LAND_SYSTEM_PROMPT = `You are an expert land and ranch real estate writer specializing in Texas farm and ranch properties. 

You write professional, compelling property descriptions that:
- Use accurate Texas ranch and land terminology
- Highlight water features, wildlife, and recreational value
- Describe topography and land character authentically  
- Include relevant improvements with appropriate detail
- Speak to the property's highest and best use
- Convey the emotional appeal of ranch ownership
- Are factual and precise about acreage, features, and location

Texas terminology you use naturally:
- "live water" for year-round creeks/rivers
- "stock tanks" for ponds
- "senderos" for cut paths
- "brush country" for South Texas
- "Hill Country vernacular" for the Edwards Plateau region
- "whitetail genetics" for quality deer herds
- "ag exemption" for agricultural tax status
- "surface only" for mineral right transfers

Write in a professional broker voice - authoritative, accurate, and compelling. 
Avoid clichés like "nestled" or "stunning views."
Keep descriptions between 150-250 words unless the property warrants more detail.
Return ONLY the property description text, no other commentary.`;

export async function POST(request: NextRequest) {
  try {
    const form = await request.json();

    const propertyDetails = `
Property: ${form.property_name || 'Unnamed Ranch'}
County: ${form.county}, ${form.state}
Acres: ${form.acres} acres
Sale Price: $${parseInt(form.sale_price || '0').toLocaleString()} ($${form.acres && form.sale_price ? Math.round(parseInt(form.sale_price) / parseFloat(form.acres)).toLocaleString() : 0}/acre)
Status: ${form.status}
Water: ${form.water}
Road Frontage: ${form.road_frontage}
Development Potential: ${form.dev_potential}
Best Use: ${form.best_use?.join(', ') || 'Not specified'}
Topography: ${form.topography || 'Not specified'}
Improvements: ${form.improvements_notes || 'None noted'}
Wildlife: ${form.wildlife_notes || 'Not specified'}
Minerals: ${form.minerals_sold || 'Not specified'}
Flood Plain: ${form.flood_plain_pct ? form.flood_plain_pct + '%' : 'None noted'}
${form.grantor ? `Sold by: ${form.grantor}` : ''}
${form.financing ? `Financing: ${form.financing}` : ''}
    `.trim();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 600,
      messages: [
        { role: 'system', content: LAND_SYSTEM_PROMPT },
        { role: 'user', content: `Write a professional property description for this land comp:\n\n${propertyDetails}` },
      ],
    });

    const description = completion.choices[0]?.message?.content?.trim();

    return NextResponse.json({ description });
  } catch (error) {
    console.error('Description generation error:', error);
    return NextResponse.json({ error: 'Failed to generate description' }, { status: 500 });
  }
}
