import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/app');
    }
    throw e;
  }
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4">
        <nav className="flex flex-col gap-2">
          <Link href="/admin" className="hover:underline">
            Overview
          </Link>
          <Link href="/admin/rubric" className="hover:underline">
            Schema rubric
          </Link>
        </nav>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
