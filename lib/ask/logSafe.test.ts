import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { errFields } from './logSafe';

describe('errFields', () => {
  it('never surfaces a DrizzleQueryError\'s own .message, which embeds the bound SQL params (message text)', () => {
    const secretText = 'the answer text contains a secret phrase: correct horse battery staple';
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const e = new DrizzleQueryError('INSERT INTO ask_messages (parts) VALUES ($1)', [JSON.stringify({ text: secretText })], cause);
    // Sanity check: this is exactly the leak I2 flagged — the params really do end up in .message.
    expect(e.message).toContain(secretText);

    const fields = errFields(e);
    expect(JSON.stringify(fields)).not.toContain(secretText);
    expect(fields).toEqual({ error: 'Error', code: '23505', detail: 'duplicate key value violates unique constraint' });
  });
  it('reads the error itself when it is not a DrizzleQueryError', () => {
    expect(errFields(new TypeError('bad input'))).toEqual({ error: 'TypeError', detail: 'bad input' });
  });
  it('caps detail at 200 characters', () => {
    const fields = errFields(new Error('x'.repeat(500)));
    expect(fields.detail?.length).toBe(200);
  });
  it('handles a non-Error throw without crashing', () => {
    expect(errFields('boom')).toEqual({ error: 'string' });
    expect(errFields(null)).toEqual({ error: 'object' });
  });
});
