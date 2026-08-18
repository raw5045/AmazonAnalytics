import { describe, it, expect } from 'vitest';
import { buildWelcomeEmail } from './buildWelcomeEmail';

const base = { name: 'Ryan Wood', appUrl: 'https://keywordquarry.com' };

describe('buildWelcomeEmail', () => {
  it('greets by first name when present', () => {
    const { text, html } = buildWelcomeEmail(base);
    expect(text).toContain('Hi Ryan,');
    expect(html).toContain('Hi Ryan,');
  });

  it('falls back to a plain greeting without a name', () => {
    const { text } = buildWelcomeEmail({ ...base, name: null });
    expect(text).toContain('Hi,');
  });

  it('links to the tutorials page in both variants', () => {
    const { text, html } = buildWelcomeEmail(base);
    expect(text).toContain('https://keywordquarry.com/help');
    expect(html).toContain('https://keywordquarry.com/help');
  });

  it('lists the three learning steps', () => {
    const { text } = buildWelcomeEmail(base);
    expect(text).toContain('Understand the data');
    expect(text).toContain('Focus on your market');
    expect(text).toContain('dig for winners');
  });

  it('escapes HTML in the name', () => {
    const { html } = buildWelcomeEmail({ ...base, name: '<b>x</b>' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('notes it is a one-time email', () => {
    const { text, html } = buildWelcomeEmail(base);
    expect(text).toContain('one-time');
    expect(html).toContain('one-time');
  });
});
