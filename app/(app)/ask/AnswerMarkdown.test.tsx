import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnswerMarkdown } from './AnswerMarkdown';

const appOrigin = 'https://keywordquarry.com';

describe('AnswerMarkdown', () => {
  it('renders GFM tables and links, internal links in the same tab, external in a new one', () => {
    render(
      <AnswerMarkdown appOrigin={appOrigin}>
        {'| Keyword | Rank |\n|---|---|\n| [led strip](/explorer/keyword/abc) | 12 |\n\nSee [docs](https://example.com).'}
      </AnswerMarkdown>,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'led strip' })).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
  });
  it('treats an absolute link on this deployment origin as internal too — the tools emit absolute keywordUrl values, never relative paths', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'See [led strip](https://keywordquarry.com/explorer/keyword/abc) for details.'}</AnswerMarkdown>);
    expect(screen.getByRole('link', { name: 'led strip' })).not.toHaveAttribute('target');
  });
  it('never renders raw HTML', () => {
    render(<AnswerMarkdown appOrigin={appOrigin}>{'<img src=x onerror=alert(1)> text'}</AnswerMarkdown>);
    expect(document.querySelector('img')).toBeNull();
  });
});
