/**
 * The KeywordQuarry mark (Q ring + quarry strata + key tail) as inline SVG.
 * See docs/superpowers/specs/2026-07-14-favicon-og-design.md §1.1 / §2.5.
 *
 * tile=false (default): bare artwork for navy surfaces (headers, footer).
 * tile=true: adds the rounded navy tile for light/hero contexts.
 * Decorative everywhere it's used (the wordmark carries the name), so it
 * is aria-hidden.
 */
export function BrandMark({ size = 24, tile = false }: { size?: number; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {tile && <rect width="64" height="64" rx="14" fill="#0D1C36" />}
      <circle cx="29" cy="29" r="16" fill="none" stroke="#ffffff" strokeWidth="7" />
      <path d="M29 20 L38 24.5 L29 29 L20 24.5 Z" fill="#ffffff" />
      <path d="M20 24.5 L29 29 L38 24.5 L38 29 L29 33.5 L20 29 Z" fill="#9aa3b5" />
      <path d="M20 29.5 L29 34 L38 29.5 L38 34 L29 38.5 L20 34 Z" fill="#5d6879" />
      <line x1="38.5" y1="38.5" x2="53" y2="53" stroke={tile ? '#0D1C36' : '#0B1E3A'} strokeWidth="12" strokeLinecap="round" />
      <circle cx="39.5" cy="39.5" r="6" fill="#38bdf8" />
      <line x1="39" y1="39" x2="52" y2="52" stroke="#38bdf8" strokeWidth="6.5" strokeLinecap="round" />
      <line x1="47" y1="47" x2="44.2" y2="49.8" stroke="#38bdf8" strokeWidth="4" />
      <line x1="51" y1="51" x2="48.2" y2="53.8" stroke="#38bdf8" strokeWidth="4" />
    </svg>
  );
}
