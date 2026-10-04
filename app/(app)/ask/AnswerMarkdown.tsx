'use client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A link is internal only when its RESOLVED origin equals this deployment's own origin (Task 9
 * fix round, item 9; spec review "Different" #4); since 2026-10-01 that only decides the referrer
 * policy — every link opens in a new tab. `new URL(href, appOrigin)` also resolves a
 * relative href like `/explorer/keyword/...` (what the research tools' absolute `keywordUrl`
 * values collapse to once compared this way) — no separate `startsWith('/')` case needed. Plain
 * prefix matching was too loose: `https://keywordquarry.com.evil.example` passed a
 * `startsWith(appOrigin)` check, and a protocol-relative `//evil.example/x` passed a
 * `startsWith('/')` check; both are external hosts.
 */
function isInternal(href: string, appOrigin: string): boolean {
  try {
    return new URL(href, appOrigin).origin === appOrigin;
  } catch {
    return false;
  }
}

/**
 * GFM tables and links; react-markdown renders no raw HTML by default (spec §6). Images are
 * dropped entirely (Task 9 fix round, item 4) — the model's output is untrusted (spec §13), and an
 * `<img src>` is a way to make the member's browser fetch an attacker-chosen URL with no
 * confirmation. Every link opens in a new tab so the chat stays where it is (owner, 2026-10-01);
 * an internal link keeps the referrer (`noopener`), an external one sends none (`noopener noreferrer`).
 * A long unbroken string wraps anywhere, so it never widens the page on a phone; a table resets
 * that to normal wrapping, because `anywhere` also shrinks a cell's minimum width: its columns
 * would squeeze and break words and numbers mid-way instead of the table scrolling sideways.
 */
export function AnswerMarkdown({ children, appOrigin }: { children: string; appOrigin: string }) {
  return (
    <div className="prose-sm max-w-none wrap-anywhere [&_table]:my-2 [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_p]:my-1">
      <Markdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img']}
        components={{
          a: ({ href, children: linkText }) => {
            const internal = typeof href === 'string' && isInternal(href, appOrigin);
            return <a href={href} className="text-blue-700 underline" target="_blank" rel={internal ? 'noopener' : 'noopener noreferrer'}>{linkText}</a>;
          },
          table: ({ children: rows }) => <div className="overflow-x-auto"><table className="min-w-full text-sm wrap-normal">{rows}</table></div>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
