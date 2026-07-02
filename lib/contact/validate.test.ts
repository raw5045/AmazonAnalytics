import { describe, it, expect } from 'vitest';
import { validateContact } from './validate';

describe('validateContact', () => {
  const good = { name: 'Jane', email: 'jane@example.com', message: 'Hello, I have a question about the explorer.' };
  it('accepts a normal submission (trimmed)', () => {
    const r = validateContact({ ...good, name: '  Jane ' });
    expect(r).toEqual({ ok: true, input: { ...good, name: 'Jane' } });
  });
  it('rejects non-object', () => expect(validateContact(null).ok).toBe(false));
  it('rejects missing/empty name', () => expect(validateContact({ ...good, name: ' ' }).ok).toBe(false));
  it('collapses control characters in name (email-subject spoofing guard)', () => {
    expect(validateContact({ ...good, name: 'Jane\r\nDoe' })).toEqual({ ok: true, input: { ...good, name: 'Jane Doe' } });
  });
  it('rejects name > 100 chars', () => expect(validateContact({ ...good, name: 'x'.repeat(101) }).ok).toBe(false));
  it('rejects a malformed email', () => expect(validateContact({ ...good, email: 'not-an-email' }).ok).toBe(false));
  it('rejects message < 10 chars', () => expect(validateContact({ ...good, message: 'hi' }).ok).toBe(false));
  it('rejects message > 5000 chars', () => expect(validateContact({ ...good, message: 'x'.repeat(5001) }).ok).toBe(false));
});
