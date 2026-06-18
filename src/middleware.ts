import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  // Protect dashboard routes — must be signed in.
  if (path.startsWith('/dashboard') && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    return NextResponse.redirect(url);
  }

  // Invite-only: kill the public signup page. Anyone who hits
  // /auth/signup gets routed to /auth/login. Accounts are created
  // only via the Supabase admin API (auth.admin.inviteUserByEmail
  // or pre-created profiles), never self-serve. This pairs with
  // the "Allow new users to sign up" toggle being OFF in the
  // Supabase dashboard, which is the authoritative server-side
  // lockdown — the middleware redirect is just UX so a curious
  // visitor doesn't even see a signup form.
  if (path.startsWith('/auth/signup')) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    return NextResponse.redirect(url);
  }

  // Redirect logged-in users away from auth pages (login, etc.).
  if (path.startsWith('/auth') && user) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard/map';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
