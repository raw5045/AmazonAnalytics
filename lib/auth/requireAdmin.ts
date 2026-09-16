import { getCurrentUser } from './getCurrentUser';
import type { User } from '@/db/schema';
import { AuthError } from './AuthError';

// Re-exported for existing call sites; the class itself lives in ./AuthError.
export { AuthError };

export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in');
  if (user.role !== 'admin') throw new AuthError('FORBIDDEN', 'Admin only');
  return user;
}
