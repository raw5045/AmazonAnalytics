'use client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A link is internal when it is site-relative, or absolute on this deployment's own origin — which is exactly what the research tools' `keywordUrl` values are (lib/research/links.ts's `keywordUrlFor` returns an absolute `${appUrl}/explorer/keyword/...` URL, never a relative path). See Task 9 D9. */
const isInternal = (href: string, appOrigin: string) => href.startsWith('/') || href.startsWith(appOrigin);

/** GFM tables and links; react-markdown renders no raw HTML by default (spec §6). Internal detail links stay in the tab; anything else opens in a new one. */
export function AnswerMarkdown({ children, appOrigin }: { children: string; appOrigin: string }) {
  return (
    <div className="prose-sm max-w-none [&_table]:my-2 [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_p]:my-1">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkText }) => {
            const internal = typeof href === 'string' && isInternal(href, appOrigin);
            return <a href={href} className="text-blue-700 underline" {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{linkText}</a>;
          },
          table: ({ children: rows }) => <div className="overflow-x-auto"><table className="min-w-full text-sm">{rows}</table></div>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
