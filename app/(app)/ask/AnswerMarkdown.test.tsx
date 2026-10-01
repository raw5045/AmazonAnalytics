import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnswerMarkdown } from './AnswerMarkdown';

const appOrigin = 'https://keywordquarry.com';

describe('AnswerMarkdown', () => {
  it('renders GFM tables and links; every link opens in a new tab so the chat stays put (owner, 2026-10-01) — internal links keep the referrer, external ones send none', () => {
    render(
      <AnswerMarkdown appOrigin={appOrigin}>
        {'| Keyword | Rank |\n|---|---|\n| [led strip](/explorer/keyword/abc) | 12 |\n\nSee [docs](https://example.com).'}
      </AnswerMarkdown>,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    const internal = screen.getByRole('link', { name: 'led strip' });
    expect(internal).toHaveAttribute('target', '_blank');
    expect(internal).toHaveAttribute('rel', 'noopener');
    const external = screen.getByRole('link', { name: 'docs' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('treats an absolute link on this deployment origin as internal too — the tools emit absolute keywordUrl values, never relative paths', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'See [led strip](https://keywordquarry.com/explorer/keyword/abc) for details.'}</AnswerMarkdown>);
    const link = screen.getByRole('link', { name: 'led strip' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });
  it('never renders raw HTML', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'<img src=x onerror=alert(1)> text'}</AnswerMarkdown>);
    expect(document.querySelector('img')).toBeNull();
  });
  it('never renders a markdown image either (fix round item 4)', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'![x](https://attacker.example/p.png)'}</AnswerMarkdown>);
    expect(document.querySelector('img')).toBeNull();
  });
  it('rejects a same-prefix-but-different-host trick (fix round item 9)', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'[trick](https://keywordquarry.com.evil.example/x)'}</AnswerMarkdown>);
    expect(screen.getByRole('link', { name: 'trick' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('rejects a protocol-relative link to another host (fix round item 9)', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'[trick](//evil.example/y)'}</AnswerMarkdown>);
    expect(screen.getByRole('link', { name: 'trick' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
