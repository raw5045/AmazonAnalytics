import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { isUniqueViolation, pgErrorCode } from './pgErrorCode';

const pg = (code: string) => Object.assign(new Error('duplicate key value violates unique constraint "saved_views_user_name_uniq"'), { code });

describe('pgErrorCode', () => {
  it('reads the SQLSTATE off a wrapped DrizzleQueryError (the production shape) and off a bare driver error', () => {
    expect(pgErrorCode(new DrizzleQueryError('insert into "saved_views" …', ['u1', 'Lamps'], pg('23505')))).toBe('23505');
    expect(pgErrorCode(pg('23505'))).toBe('23505');
    expect(pgErrorCode(pg('42P01'))).toBe('42P01');
  });
  it('is undefined for errors without a string code', () => {
    expect(pgErrorCode(new Error('connect ETIMEDOUT'))).toBeUndefined();
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 23505 }))).toBeUndefined();
    expect(pgErrorCode(new DrizzleQueryError('select 1', [], new Error('boom')))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('boom')).toBeUndefined();
  });
  it('isUniqueViolation is true only for 23505, wrapped or not', () => {
    expect(isUniqueViolation(new DrizzleQueryError('q', [], pg('23505')))).toBe(true);
    expect(isUniqueViolation(pg('23505'))).toBe(true);
    expect(isUniqueViolation(new DrizzleQueryError('q', [], pg('23503')))).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });
});
