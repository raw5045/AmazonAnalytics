export const MAX_CUSTOM_CATEGORIES = 25;
export const MAX_NAME_LENGTH = 80;

export function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'name cannot be empty' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name cannot exceed ${MAX_NAME_LENGTH} characters` };
  return { ok: true, name };
}

/** Coerce an incoming leaf_names blob into a deduped string[] (first-occurrence order). */
export function normalizeLeafNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed UUID — guards [id] route params before hitting the DB. */
export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/** True when a DB error is a Postgres unique-constraint violation (code 23505). */
export function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505');
}
