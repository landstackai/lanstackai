'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  Layers, Database, Map, FileText, Upload,
  Settings, LogOut, Plus
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const navItems = [
  { href: '/dashboard/vault', icon: Database, label: 'Vault' },
  { href: '/dashboard/map', icon: Map, label: 'Map' },
  { href: '/dashboard/cma', icon: FileText, label: 'CMA' },
  { href: '/dashboard/import', icon: Upload, label: 'Import' },
];

/**
 * AppNav — sidebar + mobile bottom nav.
 *
 * Branded warm dark surface (`bg-ink-deep`) to match the design system's
 * "overlay/chrome" mode. Pairs with map popups + floating map buttons,
 * which all live on the same warm-dark canvas. The vault/review/import
 * content pages remain on cream — so the user gets a calm light workspace
 * with a warm dark navigation anchor on the left (Apple Dock pattern, also
 * Vercel/Linear).
 *
 * Accent colors on dark use their "light" variants from the tokens so they
 * glow against the dark surface instead of muddying:
 *   olive-light       — brand "ai" + active nav item
 *   olive-light-2     — hover on olive
 *   cream-1 / 2-text  — primary / secondary text (warm off-white scale)
 *   ink-line          — borders
 */
export default function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.push('/auth/login');
    router.refresh();
  };

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col w-44 bg-ink-deep border-r border-ink-line flex-shrink-0">
        {/* Logo — olive-light gradient swatch, warm off-white wordmark,
            olive accent on ".ai" so it reads as branded mark. */}
        <div className="p-4 border-b border-ink-line">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-olive-light to-olive flex items-center justify-center flex-shrink-0">
              <Layers size={14} className="text-ink-deep" />
            </div>
            <span className="font-semibold text-sm tracking-tight text-cream-1">
              landstack<span className="text-olive-light">.ai</span>
            </span>
          </div>
        </div>

        {/* Quick add — olive (creation action). Not iMessage blue, which
            is reserved for AI/chat sends elsewhere. */}
        <div className="p-3">
          <Link
            href="/dashboard/vault?add=true"
            className="flex items-center gap-2 w-full bg-olive-light/10 hover:bg-olive-light/15 border border-olive-light/25 text-olive-light rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
          >
            <Plus size={14} />
            Add Comp
          </Link>
        </div>

        {/* Nav items — active = olive-light tint with subtle border;
            inactive = muted cream text with subtle hover lift. Calm,
            never neon. */}
        <div className="flex-1 p-2 space-y-0.5">
          {navItems.map(({ href, icon: Icon, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all',
                  active
                    ? 'bg-olive-light/10 text-olive-light border border-olive-light/20'
                    : 'text-cream-2-text hover:text-cream-1 hover:bg-ink-elev'
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </div>

        {/* Bottom actions */}
        <div className="p-2 border-t border-ink-line space-y-0.5">
          <Link
            href="/dashboard/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-cream-2-text hover:text-cream-1 hover:bg-ink-elev transition-all"
          >
            <Settings size={16} />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-cream-2-text hover:text-red-300 hover:bg-red-500/10 transition-all"
          >
            <LogOut size={16} />
            {signingOut ? 'Signing out...' : 'Sign Out'}
          </button>
        </div>
      </nav>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-ink-deep border-t border-ink-line z-50 flex items-center justify-around px-2 py-2">
        {navItems.map(({ href, icon: Icon, label }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-all',
                active ? 'text-olive-light' : 'text-cream-3-text'
              )}
            >
              <Icon size={20} />
              <span className="text-[10px] font-semibold">{label}</span>
            </Link>
          );
        })}
        <Link
          href="/dashboard/vault?add=true"
          className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-olive-light"
        >
          <div className="w-8 h-8 rounded-full bg-olive-light flex items-center justify-center -mt-4 shadow-lg shadow-olive-light/30">
            <Plus size={18} className="text-ink-deep" />
          </div>
          <span className="text-[10px] font-semibold text-olive-light mt-0.5">Add</span>
        </Link>
      </nav>
    </>
  );
}
