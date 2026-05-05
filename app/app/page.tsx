import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { redirect } from 'next/navigation';

export default async function AppHome() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Welcome, {user.name ?? user.email}</h1>
      <p className="mt-4 text-gray-600">
        Browse Amazon SFR keyword data with the explorer.
      </p>
      <p className="mt-4">
        <a href="/explorer" className="underline">
          Open keyword explorer →
        </a>
      </p>
      {user.role === 'admin' && (
        <p className="mt-2">
          <a href="/admin" className="underline">
            Go to admin
          </a>
        </p>
      )}
    </main>
  );
}
