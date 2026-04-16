import Link from 'next/link';

export default function HomePage() {
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
