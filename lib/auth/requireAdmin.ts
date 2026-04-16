import { getCurrentUser } from './getCurrentUser';
import type { User } from '@/db/schema';

export class AuthError extends Error {
  constructor(
    public code: 'UNAUTHENTICATED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in');
  if (user.role !== 'admin') throw new AuthError('FORBIDDEN', 'Admin only');
  return user;
}
