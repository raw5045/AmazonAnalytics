/**
 * Log-safe failure logging for the Resend senders (the pattern sendAskAiCeilingEmail.ts set,
 * Task 10 review C-m8). A Resend `ErrorResponse.message` is free text from Resend's API that can
 * echo request fields — the testing-mode 403 names the account owner's address, a validation
 * error can echo an invalid `to` or `replyTo` — so a failed send logs only the error's coded
 * `name` (a closed union) and its `statusCode`. A thrown error (network/client failure) logs only
 * its name and `code` via errFields — never its `.message`, which could embed request data.
 * Neither helper throws; the senders stay fail-soft.
 */
import type { ErrorResponse } from 'resend';
import { errFields } from '@/lib/ask/logSafe';

export function logResendError(tag: string, error: ErrorResponse): void {
  console.error(tag, JSON.stringify({ outcome: 'resend_error', code: error.name, statusCode: error.statusCode }));
}

export function logSendThrew(tag: string, e: unknown): void {
  const { error, code } = errFields(e);
  console.error(tag, JSON.stringify({ outcome: 'send_threw', error, code }));
}
