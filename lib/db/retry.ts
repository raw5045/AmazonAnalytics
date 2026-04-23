/**
 * Retry a DB operation on transient network errors.
 *
 * The Neon HTTP driver uses a global fetch client whose connection state can
 * go stale on long-idle worker containers. The first query after ~15 min idle
 * often fails with "TypeError: fetch failed" / AggregateError from undici.
 * Retrying with a fresh network attempt almost always succeeds.
 *
 * We retry up to `attempts` times with exponential-ish backoff. Only retries
 * on network-shaped errors — actual SQL errors (constraint violations, etc.)
 * surface immediately.
 */
export async function withNeonRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e) || i === attempts - 1) throw e;
      const delay = baseMs * Math.pow(2, i);
      // eslint-disable-next-line no-console
      console.warn(`[retry] transient DB error, retrying in ${delay}ms (attempt ${i + 1}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

function isTransientNetworkError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;

  // WebSocket Pool surfaces its connection failures as ErrorEvent instances
  // from the DOM-style event API. Recognize by shape even when there's no
  // useful message string.
  const err = e as { cause?: unknown };
  if (isErrorEventLike(err.cause) || isErrorEventLike(e)) return true;

  const msg = messageOf(e);
  return (
    msg.includes('fetch failed') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('socket hang up') ||
    msg.includes('query_wait_timeout') ||
    msg.includes('Error connecting to database') ||
    msg.includes('Connection terminated') ||
    msg.includes('terminating connection') ||
    msg.includes('WebSocket')
  );
}

function isErrorEventLike(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const ev = e as { type?: unknown; timeStamp?: unknown; defaultPrevented?: unknown };
  return ev.type === 'error' && typeof ev.timeStamp === 'number';
}

function messageOf(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e);
  const parts: string[] = [];
  const err = e as { message?: string; cause?: unknown; sourceError?: unknown };
  if (typeof err.message === 'string') parts.push(err.message);
  if (err.cause) parts.push(messageOf(err.cause));
  if (err.sourceError) parts.push(messageOf(err.sourceError));
  return parts.join(' | ');
}
