import { getCurrentUser } from './getCurrentUser';
import { AuthError } from './requireAdmin';
import type { User } from '@/db/schema';

export async function requireAuthenticatedUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in');
  return user;
}
