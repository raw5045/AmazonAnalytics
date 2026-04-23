'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Polls server data while a batch is mid-flight (uploading, validating, or
 * importing). Stops when the batch reaches a terminal state or any file is
 * still pending validation. Refresh interval defaults to 3 seconds —
 * lightweight enough to feel live without hammering Neon.
 */
export function AutoRefresh({ shouldRefresh, intervalMs = 3000 }: { shouldRefresh: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!shouldRefresh) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [shouldRefresh, intervalMs, router]);
  return null;
}
