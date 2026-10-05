// services/keepa/log.test.ts
import { describe, it, expect, vi } from 'vitest';
import { errFields, logLine } from './log';

describe('errFields', () => {
  it('keeps the name, a Postgres code and an HTTP status — never the message', () => {
    const pgErr = Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' });
    expect(errFields(pgErr)).toEqual({ error: 'Error', code: '28P01' });
    const http = Object.assign(new Error('keepa_http_503'), { name: 'KeepaHttpError', status: 503 });
    expect(errFields(http)).toEqual({ error: 'KeepaHttpError', status: 503 });
    expect(JSON.stringify(errFields(pgErr))).not.toContain('password');
    expect(errFields('boom')).toEqual({ error: 'string' });
  });
});

describe('logLine', () => {
  it('writes one JSON line under the service tag', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logLine({ event: 'batch', lane: 'new', requested: 100 });
    expect(spy).toHaveBeenCalledWith('[keepa-svc]', '{"event":"batch","lane":"new","requested":100}');
    spy.mockRestore();
  });
});
