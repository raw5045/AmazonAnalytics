/**
 * Log-safe failure logging for the Resend senders. A Resend `ErrorResponse.message` is free text
 * from Resend's API that can echo request fields — the testing-mode 403 names the account owner's
 * address, a validation error can echo an invalid `to` or `replyTo` — so a failed send logs only
 * the error's coded `name` (typed as a closed union; the SDK passes the parsed body through
 * unvalidated, so a malformed body simply logs fewer fields) and its `statusCode`. A thrown error
 * (network/client failure) and a failed recipient lookup log only the error's name and `code` via
 * errFields — never its `.message`, which could embed request data. None of these helpers throw;
 * the senders stay fail-soft.
 */
import type { ErrorResponse } from 'resend';
import { errFields } from '@/lib/ask/logSafe';

export function logResendError(tag: string, error: ErrorResponse): void {
  console.error(tag, JSON.stringify({ outcome: 'resend_error', code: error.name, statusCode: error.statusCode }));
}

/** Only `error` and `code` are logged: errFields' `detail` is the message, which is exactly what must stay out. */
function codedFields(e: unknown): { error: string; code?: string } {
  const { error, code } = errFields(e);
  return { error, code };
}

export function logSendThrew(tag: string, e: unknown): void {
  console.error(tag, JSON.stringify({ outcome: 'send_threw', ...codedFields(e) }));
}

/** The admin-recipient lookup failed (a database error): same discipline, plus the Postgres code when there is one. */
export function logLookupFailed(tag: string, e: unknown): void {
  console.error(tag, JSON.stringify({ outcome: 'lookup_failed', ...codedFields(e) }));
}
