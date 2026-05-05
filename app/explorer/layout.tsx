import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';

export default async function ExplorerLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) redirect('/sign-in');
    throw e;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <Link href="/explorer" className="text-lg font-semibold">
          Keyword Explorer
        </Link>
        <div className="text-sm text-gray-600 flex items-center gap-4">
          <span>{user.email}</span>
          {user.role === 'admin' && (
            <Link href="/admin" className="underline">
              Admin
            </Link>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
