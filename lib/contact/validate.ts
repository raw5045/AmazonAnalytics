export interface ContactInput {
  name: string;
  email: string;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(
  raw: unknown,
): { ok: true; input: ContactInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid payload' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const email = typeof r.email === 'string' ? r.email.trim() : '';
  const message = typeof r.message === 'string' ? r.message.trim() : '';
  if (name.length === 0 || name.length > 100) return { ok: false, error: 'name must be 1–100 characters' };
  if (!EMAIL_RE.test(email) || email.length > 200) return { ok: false, error: 'enter a valid email address' };
  if (message.length < 10 || message.length > 5000) return { ok: false, error: 'message must be 10–5,000 characters' };
  return { ok: true, input: { name, email, message } };
}
