// app/api/mcp/routeDeadline.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_READ_TIMEOUT_MS } from '@/lib/products/searchProducts';

describe('/api/mcp maxDuration', () => {
  it("is a literal at least 10 s past the product reads' statement cap, so a capped read still answers QUERY_TIMEOUT before the invocation ends", () => {
    // Read from the source, as Next reads route segment config: the value must stay a plain number literal.
    const source = readFileSync('app/api/mcp/route.ts', 'utf8');
    const match = /^export const maxDuration = (\d+);$/m.exec(source);
    expect(match, 'export const maxDuration = <seconds>; in app/api/mcp/route.ts').not.toBeNull();
    const maxDuration = Number(match![1]);
    expect(maxDuration * 1000).toBeGreaterThanOrEqual(PRODUCT_READ_TIMEOUT_MS + 10_000);
  });
});
