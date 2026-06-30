import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const { userId } = await auth();
  if (userId) {
    // Signed-in visitors skip the marketing splash. Keep this destination in
    // sync with NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL / _AFTER_SIGN_UP_URL (both
    // '/app'), which Clerk reads from the env to land users right after auth.
    redirect('/app');
  }
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">Amazon SFR Analytics</h1>
      <div className="flex gap-4">
        <Link className="underline" href="/sign-in">
          Sign in
        </Link>
        <Link className="underline" href="/sign-up">
          Sign up
        </Link>
      </div>
    </main>
  );
}
