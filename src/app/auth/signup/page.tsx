// Signup page — INVITE ONLY.
//
// Landstack runs as an invite-only product right now. Brokers and their
// teams get accounts by being invited from the Supabase dashboard, which
// sends a magic-link email. Clicking that link signs them in directly
// (via /auth/callback) — they never see this page.
//
// Someone who lands HERE (typed /auth/signup, clicked a stale link,
// found us in search) doesn't get a tempting empty form that'll error
// the moment they submit. They get a clean "we're invite-only" message
// + a path to log in if they already have an account, + a contact path
// if they want to request access.
//
// This is the UI half of "closing public signup." The matching server
// half is the Supabase setting:
//   Supabase → Authentication → Providers → Email → "Allow new users
//   to sign up" = OFF
// Even if that toggle is somehow on, this page doesn't show a form, so
// no one can sign up by accident.

import Link from 'next/link';
import { Layers, Lock } from 'lucide-react';

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-olive-tint blur-3xl" />
      </div>

      <div className="w-full max-w-sm relative">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-olive to-olive-2 flex items-center justify-center">
              <Layers size={16} className="text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              landstack<span className="text-olive-2">.ai</span>
            </span>
          </div>
        </div>

        <div className="bg-white border border-beige rounded-2xl p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-olive-tint mb-4">
            <Lock size={18} className="text-olive-2" />
          </div>

          <h1 className="text-xl font-bold text-ink mb-2">
            Invite only
          </h1>

          <p className="text-sm text-ink-2 leading-relaxed mb-6">
            Landstack is currently available by invitation. If you&rsquo;ve been
            invited, check your email for a sign-in link. If you already have
            an account, sign in below.
          </p>

          <Link
            href="/auth/login"
            className="block w-full bg-olive hover:bg-olive-2 text-white font-bold py-2.5 rounded-lg text-sm transition-colors"
          >
            Sign in
          </Link>

          <p className="text-xs text-ink-3 mt-4">
            Want to request access?{' '}
            <a
              href="mailto:hello@landstack.ai?subject=Landstack%20access%20request"
              className="text-olive-2 hover:underline font-semibold"
            >
              Get in touch
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
