import { describe, it, expect } from 'vitest';
import { buildFeedbackEmail } from './buildFeedbackEmail';

const base = {
  message: 'Love the title-gap filter. Could the watchlist sort by delta?',
  page: '/explorer?title_match=any',
  user: { id: '11111111-2222-3333-4444-555555555555', email: 'jane@example.com', name: 'Jane Doe' },
  appUrl: 'https://keywordquarry.com',
};

describe('buildFeedbackEmail', () => {
  it('uses the name in the subject and the From line', () => {
    const e = buildFeedbackEmail(base);
    expect(e.subject).toBe('💬 Feedback from Jane Doe');
    expect(e.text).toContain('From: Jane Doe <jane@example.com>');
    expect(e.html).toContain('Jane Doe &lt;jane@example.com&gt;');
  });
  it('falls back to the email when the name is null', () => {
    const e = buildFeedbackEmail({ ...base, user: { ...base.user, name: null } });
    expect(e.subject).toBe('💬 Feedback from jane@example.com');
    expect(e.text).toContain('From: jane@example.com');
  });
  it('collapses control characters in the name (subject spoofing guard)', () => {
    const e = buildFeedbackEmail({ ...base, user: { ...base.user, name: 'Jane\r\nDoe' } });
    expect(e.subject).toBe('💬 Feedback from Jane Doe');
  });
  it('renders the absolute page link in text and as an anchor in html', () => {
    const e = buildFeedbackEmail(base);
    expect(e.text).toContain('Page: https://keywordquarry.com/explorer?title_match=any');
    expect(e.html).toContain('<a href="https://keywordquarry.com/explorer?title_match=any"');
  });
  it('escapes ampersands and quotes inside the href so the attribute cannot break', () => {
    const amp = buildFeedbackEmail({ ...base, page: '/explorer?rank_max=100&words_min=3' });
    expect(amp.html).toContain('href="https://keywordquarry.com/explorer?rank_max=100&amp;words_min=3"');
    const quoted = buildFeedbackEmail({ ...base, page: '/explorer?q="x"' });
    expect(quoted.html).toContain('href="https://keywordquarry.com/explorer?q=&quot;x&quot;"');
    expect(quoted.html).not.toContain('?q="x"');
  });
  it('says the page was not captured when null', () => {
    const e = buildFeedbackEmail({ ...base, page: null });
    expect(e.text).toContain('Page: (not captured)');
    expect(e.html).toContain('(not captured)');
    expect(e.html).not.toContain('<a href');
  });
  it('includes the account id and HTML-escapes the message', () => {
    const e = buildFeedbackEmail({ ...base, message: '<script>alert(1)</script> & "quotes"' });
    expect(e.text).toContain(`Account: ${base.user.id}`);
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(e.html).not.toContain('<script>');
  });
});
