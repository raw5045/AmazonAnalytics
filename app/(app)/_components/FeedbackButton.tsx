'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * "Feedback" link in the app header → one-box modal → POST /api/feedback.
 *
 * The API attaches the account email (reply-to) and the page the member was
 * on (read from window.location at submit time), so nothing is re-typed.
 * The overlay is portaled into <body> so the sticky header's stacking
 * context can't clip it. Escape / backdrop / Cancel close it (not while
 * sending); focus returns to the header button. Typed text survives an
 * error and a Cancel; it is cleared only after a successful send.
 * See docs/superpowers/specs/2026-09-15-feedback-button-design.md.
 */
type Status = 'idle' | 'sending' | 'sent' | 'error';

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    if (status === 'sending') return;
    if (status === 'sent') setMessage('');
    setOpen(false);
    setStatus('idle');
    setError(null);
    buttonRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length < MESSAGE_MIN) {
      setError(`Please write at least ${MESSAGE_MIN} characters.`);
      setStatus('error');
      return;
    }
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          page: window.location.pathname + window.location.search,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setStatus('error');
        return;
      }
      setStatus('sent');
    } catch {
      setError('Network error — please check your connection and try again.');
      setStatus('error');
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        className="text-slate-300 hover:text-white"
      >
        Feedback
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="w-full max-w-md rounded-xl bg-white p-6 text-left shadow-xl"
            >
              {status === 'sent' ? (
                <>
                  <h2 id={titleId} className="text-lg font-semibold text-gray-900">
                    Thanks — got it.
                  </h2>
                  <p className="mt-2 text-sm text-gray-600">We&apos;ll reply by email if needed.</p>
                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={close}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={handleSubmit}>
                  <h2 id={titleId} className="text-lg font-semibold text-gray-900">
                    Send feedback
                  </h2>
                  <p className="mt-1 text-sm text-gray-600">
                    What&apos;s confusing, missing, or would make KeywordQuarry more useful? We read
                    every message.
                  </p>
                  <textarea
                    autoFocus
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={MESSAGE_MAX}
                    rows={6}
                    aria-label="Your feedback"
                    disabled={status === 'sending'}
                    className="mt-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                  />
                  {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={close}
                      disabled={status === 'sending'}
                      className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={status === 'sending'}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                    >
                      {status === 'sending' ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
