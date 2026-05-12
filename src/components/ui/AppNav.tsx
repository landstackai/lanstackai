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
import toast from 'react-hot-toast';

const navItems = [
  { href: '/dashboard/vault', icon: Database, label: 'Vault' },
  { href: '/dashboard/map', icon: Map, label: 'Map' },
  { href: '/dashboard/cma', icon: FileText, label: 'CMA' },
  { href: '/dashboard/import', icon: Upload, label: 'Import' },
];

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
      <nav className="hidden md:flex flex-col w-44 bg-panel border-r border-border flex-shrink-0">
        {/* Logo */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sage to-sage2 flex items-center justify-center flex-shrink-0">
              <Layers size={14} className="text-black" />
            </div>
            <span className="font-bold text-sm tracking-tight">
              landstack<span className="text-sage">.ai</span>
            </span>
          </div>
        </div>

        {/* Quick add */}
        <div className="p-3">
          <Link
            href="/dashboard/vault?add=true"
            className="flex items-center gap-2 w-full bg-sage/10 hover:bg-sage/20 border border-sage/20 text-sage rounded-lg px-3 py-2 text-xs font-bold transition-colors"
          >
            <Plus size={14} />
            Add Comp
          </Link>
        </div>

        {/* Nav items */}
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
                    ? 'bg-sage/10 text-sage border border-sage/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </div>

        {/* Bottom actions */}
        <div className="p-2 border-t border-border space-y-0.5">
          <Link
            href="/dashboard/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all"
          >
            <Settings size={16} />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-slate-400 hover:text-red-400 hover:bg-red-400/5 transition-all"
          >
            <LogOut size={16} />
            {signingOut ? 'Signing out...' : 'Sign Out'}
          </button>
        </div>
      </nav>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-panel border-t border-border z-50 flex items-center justify-around px-2 py-2">
        {navItems.map(({ href, icon: Icon, label }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-all',
                active ? 'text-sage' : 'text-slate-500'
              )}
            >
              <Icon size={20} />
              <span className="text-[10px] font-bold">{label}</span>
            </Link>
          );
        })}
        <Link
          href="/dashboard/vault?add=true"
          className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-sage"
        >
          <div className="w-8 h-8 rounded-full bg-sage flex items-center justify-center -mt-4 shadow-lg shadow-sage/30">
            <Plus size={18} className="text-black" />
          </div>
          <span className="text-[10px] font-bold text-sage mt-0.5">Add</span>
        </Link>
      </nav>
    </>
  );
}
