import { SignOutButton } from '@clerk/nextjs';

/**
 * Terminal screen for a signed-in session whose app user cannot be resolved
 * or provisioned (AuthError 'UNPROVISIONABLE': Clerk no longer has the user,
 * or the user has no email address). Rendered IN PLACE of the app shell
 * instead of redirecting to /sign-in — Clerk's sign-in widget would bounce a
 * still-signed-in visitor straight back and loop.
 */
export function AccountProblem({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F4F6FA] p-6">
      <div className="card-app max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold text-gray-900">We couldn&apos;t load your account</h1>
        <p className="mt-3 text-sm text-gray-600">{message}</p>
        <p className="mt-2 text-sm text-gray-600">
          Signing out and back in usually fixes this. If it doesn&apos;t, email{' '}
          <a href="mailto:support@keywordquarry.com" className="font-medium text-blue-700 underline">
            support@keywordquarry.com
          </a>{' '}
          and we&apos;ll sort it out.
        </p>
        <div className="mt-6">
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Sign out
            </button>
          </SignOutButton>
        </div>
      </div>
    </div>
  );
}
