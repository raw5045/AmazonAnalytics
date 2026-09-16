/**
 * Auth failures that layouts and route handlers translate into redirects or
 * status codes. Lives in its own module so getCurrentUser can throw it without
 * importing requireAdmin (which itself imports getCurrentUser).
 *
 *   UNAUTHENTICATED  no Clerk session                 → /sign-in (401 in APIs)
 *   FORBIDDEN        signed in, lacks the role        → /explorer (403 in APIs)
 *   UNPROVISIONABLE  signed in, but no app user can   → terminal "sign out"
 *                    be resolved or created for the     screen (403 in APIs) —
 *                    session (Clerk 404, no email)      never /sign-in, whose
 *                                                       widget bounces a
 *                                                       signed-in visitor back
 */
export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNPROVISIONABLE';

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
