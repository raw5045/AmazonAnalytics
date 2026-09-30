import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { logLookupFailed, logSendThrew } from './logSendFailure';
import { consoleLines } from '../../tests/unit/consoleLines';

const ADDRESS = 'someone@example.com';

describe('logSendFailure helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logLookupFailed logs the underlying error name and code, never the query text or its params', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = Object.assign(new Error(`relation "users" does not exist near ${ADDRESS}`), { code: '42P01' });
    const e = new DrizzleQueryError(`SELECT email FROM users WHERE email = $1`, [ADDRESS], cause);
    logLookupFailed('[sendImportEmail]', e);
    const lines = consoleLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"outcome":"lookup_failed"');
    expect(lines[0]).toContain('"code":"42P01"');
    expect(lines[0]).not.toContain(ADDRESS);
  });

  it('logSendThrew drops the message even for a plain Error that embeds an address', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSendThrew('[sendContactEmail]', Object.assign(new Error(`failed for ${ADDRESS}`), { code: 'ECONNRESET' }));
    const lines = consoleLines(spy);
    expect(lines[0]).toContain('"outcome":"send_threw"');
    expect(lines[0]).toContain('"code":"ECONNRESET"');
    expect(lines[0]).not.toContain(ADDRESS);
  });
});
