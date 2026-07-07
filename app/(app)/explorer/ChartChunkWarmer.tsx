'use client';

import { useEffect } from 'react';

/**
 * Warms the recharts chunk while the user is browsing the explorer list.
 *
 * recharts (~103 KB gzip) is loaded only by the keyword-detail charts, so the
 * FIRST detail page a user opens otherwise pays the full download before the
 * charts can render. On idle, this fires the SAME dynamic imports the detail
 * page's LazyCharts use, pulling the shared chunk into the browser cache so it's
 * already there by the first keyword click. Subsequent detail pages reuse it.
 *
 * Important: this warms only the shared chart *code* (one file, once) — it does
 * NOT prefetch any per-keyword data. Renders nothing.
 */
export function ChartChunkWarmer() {
  useEffect(() => {
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const warm = () => {
      // Same module specifier LazyCharts uses → same chunk → cache reuse.
      void import('./keyword/[id]/TrendChart');
    };

    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(warm, { timeout: 2500 });
    } else {
      timeoutId = setTimeout(warm, 1500);
    }

    return () => {
      if (idleId !== undefined && typeof w.cancelIdleCallback === 'function') {
        w.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, []);

  return null;
}
