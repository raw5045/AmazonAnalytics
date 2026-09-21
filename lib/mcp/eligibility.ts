import type { McpAudience } from './config';

/** Who sees the Connect AI page and nav item — the same rule the gate applies to tokens. */
export function connectAiEligible(role: 'admin' | 'standard_user', audience: McpAudience): boolean {
  return audience === 'all' || role === 'admin';
}
