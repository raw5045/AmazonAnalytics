import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
import { isSameOrigin } from './sameOrigin';

const req = (h: Record<string, string>) => new Request('https://keywordquarry.com/api/ask/chat', { method: 'POST', headers: h });

describe('isSameOrigin', () => {
  it('accepts a same-origin browser POST', () => {
    expect(isSameOrigin(req({ origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });
  it('rejects a cross-site fetch by Sec-Fetch-Site, by Origin, or a missing Origin', () => {
    expect(isSameOrigin(req({ origin: 'https://keywordquarry.com', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(req({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isSameOrigin(req({ origin: 'null' }))).toBe(false);
  });
  it('treats Sec-Fetch-Site none (typed URL / bookmark) with a matching Origin as ours', () => {
    expect(isSameOrigin(req({ origin: 'https://keywordquarry.com', 'sec-fetch-site': 'none' }))).toBe(true);
  });
});
