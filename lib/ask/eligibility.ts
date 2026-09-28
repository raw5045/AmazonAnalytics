/**
 * Who sees the Ask AI tab, the page and the /api/ask routes (spec §9.5 gate 2): admins always;
 * a member only with an ask_accounts row whose `access` is true (granted by an admin now, by the
 * Stripe arc later). Balance is a separate, later gate — a member with access and no balance
 * still sees the page and their old chats.
 */
export function askAiEligible(role: 'admin' | 'standard_user', account: { access: boolean } | null): boolean {
  return role === 'admin' || account?.access === true;
}
