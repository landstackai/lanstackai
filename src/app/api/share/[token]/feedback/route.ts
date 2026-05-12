import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/share/[token]/feedback
 *
 * Receives a message from a client viewing a public CMA share report.
 * The client can be unauthenticated — that's by design. We use the anon
 * Supabase client and the RLS policy from migration 009 ensures the row
 * can only be inserted if it references a non-expired shared CMA.
 *
 * Email-out integration (notify the broker via Resend/SendGrid/etc.) is
 * intentionally NOT wired up here. Persistence first; notification is a
 * follow-up that requires a service credential the project may not have yet.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const message = String(body.message ?? '').trim();
    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }
    if (message.length > 5000) {
      return NextResponse.json({ error: 'Message too long (max 5000)' }, { status: 400 });
    }
    const client_name = body.client_name ? String(body.client_name).trim().slice(0, 200) : null;
    const client_email = body.client_email ? String(body.client_email).trim().slice(0, 200) : null;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // Use the anon client. RLS will enforce that the share_token corresponds
    // to a non-expired shared CMA — we don't have to re-validate here.
    const supabase = createClient(supabaseUrl, anonKey);

    // Look up the CMA id from the token. Anon read is allowed for shared CMAs
    // (migration 008). If no row matches, the share is invalid/expired.
    const { data: cma, error: cmaErr } = await supabase
      .from('cmas')
      .select('id')
      .eq('share_token', params.token)
      .maybeSingle();

    if (cmaErr || !cma) {
      return NextResponse.json(
        { error: 'Share link not found or expired' },
        { status: 404 }
      );
    }

    // Insert the feedback row. RLS check from migration 009 will verify the
    // share_token and CMA id match again, so this is safe.
    const { error: insertErr } = await supabase.from('share_feedback').insert({
      cma_id: cma.id,
      share_token: params.token,
      client_name,
      client_email,
      message,
    });

    if (insertErr) {
      // Most likely cause if this fails: migration 009 hasn't been applied yet.
      return NextResponse.json(
        { error: insertErr.message || 'Could not save feedback' },
        { status: 500 }
      );
    }

    // TODO(email): notify the broker via email service. Pseudocode:
    //   const broker = await getBrokerEmail(cma.id);
    //   await resend.send({ to: broker.email, subject: 'New CMA reply', text: message });
    // For now the broker reads messages in their dashboard.

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Server error' },
      { status: 500 }
    );
  }
}
