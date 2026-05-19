'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Eye, EyeOff, Layers } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      router.push('/dashboard/map');
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      {/* Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-olive-tint blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-blue-500/5 blur-3xl" />
      </div>

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-olive to-olive-2 flex items-center justify-center">
              <Layers size={16} className="text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              landstack<span className="text-olive-2">.ai</span>
            </span>
          </div>
          <h1 className="text-2xl font-bold text-ink mb-1">Welcome back</h1>
          <p className="text-sm text-ink-2">Sign in to your account</p>
        </div>

        {/* Form */}
        <div className="bg-white border border-beige rounded-2xl p-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-ink-2 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="w-full bg-cream border border-beige rounded-lg px-3 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive focus:ring-1 focus:ring-olive/20 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-2 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-cream border border-beige rounded-lg px-3 py-2.5 pr-10 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive focus:ring-1 focus:ring-olive/20 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink-2"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-olive hover:bg-olive-2 text-white font-bold py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-xs text-ink-3">
              Don't have an account?{' '}
              <Link href="/auth/signup" className="text-olive-2 hover:underline font-semibold">
                Sign up
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-ink-3 mt-6">
          The intelligence layer for land.
        </p>
      </div>
    </div>
  );
}
