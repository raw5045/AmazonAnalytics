'use client';

// Catches errors thrown in the root layout itself. This file REPLACES the root
// layout when active, so it must render its own <html>/<body> and can't rely on
// globals.css/Tailwind — hence inline styles.
import { useEffect } from 'react';

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[global error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#111827',
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong</h2>
          <p style={{ marginTop: 8, color: '#4b5563', fontSize: 14 }}>
            The app hit an unexpected error. Please try again.
          </p>
          <button
            onClick={() => unstable_retry()}
            style={{
              marginTop: 16,
              background: '#111827',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
