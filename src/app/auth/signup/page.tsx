'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Layers } from 'lucide-react';

export default function SignupPage() {
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    password: '',
    brokerage_name: '',
  });
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email: formData.email,
      password: formData.password,
      options: {
        data: {
          full_name: formData.full_name,
          brokerage_name: formData.brokerage_name,
        },
      },
    });

    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      toast.success('Account created! Welcome to Landstack AI.');
      router.push('/dashboard/map');
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-night flex items-center justify-center p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-sage/5 blur-3xl" />
      </div>

      <div className="w-full max-w-sm relative">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sage to-sage2 flex items-center justify-center">
              <Layers size={16} className="text-black" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              landstack<span className="text-sage">.ai</span>
            </span>
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Create account</h1>
          <p className="text-sm text-slate-400">Start your 14-day free trial</p>
        </div>

        <div className="bg-panel border border-border rounded-2xl p-6">
          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Full Name
              </label>
              <input
                type="text"
                value={formData.full_name}
                onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                placeholder="Louie Swope"
                required
                className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Brokerage Name
              </label>
              <input
                type="text"
                value={formData.brokerage_name}
                onChange={(e) => setFormData({ ...formData, brokerage_name: e.target.value })}
                placeholder="Your Brokerage"
                className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="you@example.com"
                required
                className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Min 8 characters"
                required
                minLength={8}
                className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-sage hover:bg-sage2 text-black font-bold py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {loading ? 'Creating account...' : 'Create Account — Free'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-xs text-slate-500">
              Already have an account?{' '}
              <Link href="/auth/login" className="text-sage hover:underline font-semibold">
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-4">
          No credit card required · 14-day free trial
        </p>
      </div>
    </div>
  );
}
