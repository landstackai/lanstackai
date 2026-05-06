import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const IMPORT_SYSTEM_PROMPT = `You are Landstack AI — a land and ranch real estate data extraction specialist built for Texas land brokers.

Your job is to:
1. Read property documents, appraisals, closing statements, and descriptions
2. Extract comparable sales data with high accuracy  
3. Answer questions about the documents conversationally
4. Help brokers add comps to their vault

You understand deeply:
- Texas ranch and land terminology (live water, senderos, brush country, Hill Country, stock tanks, MLD, ag exemption)
- Appraisal report structure (subject property + comparable sales)
- ECV = Estimated Contributory Value of improvements
- Land-only adjusted price vs total sale price
- Surface rights vs mineral rights
- Recording numbers and county deed records
- Marshall & Swift cost approach methodology
- Texas submarket terminology (Hill Country, South Texas, West Texas, Panhandle, Gulf Coast, etc.)

When you find comparable sales in a document:
- Extract ALL comps, not just the subject property
- Note the difference between total sale price and land-only adjusted price
- Flag when improvements value (ECV) is mentioned
- Extract GPS coordinates if present (lat/long format)
- Extract recording numbers for verification

CRITICAL: When you extract comps, you MUST return them in the structured JSON format in your response.
Format your response as:
1. A friendly conversational message explaining what you found
2. Then a JSON block with the comps: \`\`\`json\n{"comps": [...]}\`\`\`

Each comp should have these fields:
{
  "property_name": string or null,
  "county": string or null,
  "state": string (default "TX"),
  "acres": number or null,
  "sale_price": number or null,
  "price_land_only": number or null,
  "improvements_value": number or null,
  "price_per_acre": number or null,
  "ppa_land_only": number or null,
  "sale_date": "YYYY-MM-DD" or null,
  "address": string or null,
  "latitude": number or null,
  "longitude": number or null,
  "parcel_id": string or null,
  "recording_number": string or null,
  "grantor": string or null,
  "grantee": string or null,
  "financing": string or null,
  "minerals_sold": string or null,
  "confirmation_source": string or null,
  "water": "None" | "Seasonal" | "Strong" or null,
  "road_frontage": "None" | "Low" | "Medium" | "High" or null,
  "has_improvements": boolean,
  "improvements_notes": string or null,
  "wildlife_notes": string or null,
  "flood_plain_pct": number or null,
  "description": string or null,
  "is_subject_property": boolean,
  "is_comparable": boolean,
  "confidence": {
    "overall": number (0-100),
    "per_field": {}
  }
}

For conversational questions (not document extraction), just respond naturally without the JSON block.
Be concise, professional, and speak like a knowledgeable land appraiser.`;

export async function POST(request: NextRequest) {
  try {
    const { messages, documentContent } = await request.json();

    const systemMessages = [
      { role: 'system' as const, content: IMPORT_SYSTEM_PROMPT },
    ];

    // If document content provided, add it as context
    const processedMessages = messages.map((m: any) => {
      if (m.role === 'user' && documentContent && m === messages[messages.length - 1]) {
        return {
          role: 'user' as const,
          content: `Please extract all comparable sales from this document:\n\n${documentContent}`,
        };
      }
      return { role: m.role as const, content: m.content };
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2000,
      messages: [...systemMessages, ...processedMessages],
    });

    const responseText = completion.choices[0]?.message?.content || '';

    // Extract JSON comps from response if present
    let comps = null;
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        comps = parsed.comps?.filter((c: any) => c.is_comparable || (!c.is_subject_property));
      } catch (e) {
        console.error('Failed to parse comps JSON:', e);
      }
    }

    // Clean message (remove JSON block for display)
    const cleanMessage = responseText.replace(/```json\n[\s\S]*?\n```/g, '').trim();

    return NextResponse.json({
      message: cleanMessage,
      comps,
    });
  } catch (error) {
    console.error('Import chat error:', error);
    return NextResponse.json(
      { message: 'Sorry, I had trouble processing that. Please try again.', comps: null },
      { status: 500 }
    );
  }
}
