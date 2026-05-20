import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import AppNav from '@/components/ui/AppNav';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/auth/login');
  }

  return (
    <div className="flex h-screen bg-cream overflow-hidden">
      <AppNav />
      <main className="flex-1 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
