import { describe, it, expect } from 'vitest';
import { buildEnrichmentEmail } from './buildEnrichmentEmail';

const baseInput = {
  weekEndDate: '2026-05-02',
  appUrl: 'https://amazon-analytics-beta.vercel.app',
  durationMs: 18 * 3_600_000 + 42 * 60_000, // 18h 42min
  tokensSpent: 281_600,
  counts: {
    active: 139_201,
    no_price: 1_389,
    delisted: 198,
    error: 69,
  },
};

describe('buildEnrichmentEmail', () => {
  describe('happy path (canonical full-week summary)', () => {
    const email = buildEnrichmentEmail(baseInput);

    it('subject is a clear positive signal', () => {
      expect(email.subject).toContain('✓');
      expect(email.subject).toContain('Keepa enrichment completed');
      expect(email.subject).toContain('2026-05-02');
    });

    it('text body shows duration as Xh Ymin', () => {
      expect(email.text).toContain('18h 42min');
    });

    it('text body lists ASIN totals and percentages', () => {
      // 139201 + 1389 + 198 + 69 = 140857
      expect(email.text).toContain('140,857');
      expect(email.text).toContain('139,201');
      // Active = 139201 / 140857 = 98.8%
      expect(email.text).toMatch(/98\.8%/);
    });

    it('text body shows each status row', () => {
      expect(email.text).toMatch(/Active.+139,201/);
      expect(email.text).toMatch(/No price.+1,389/);
      expect(email.text).toMatch(/Delisted.+198/);
      expect(email.text).toMatch(/Error.+69/);
    });

    it('text body shows tokens spent', () => {
      expect(email.text).toContain('~281,600');
    });

    it('text body links to the explorer', () => {
      expect(email.text).toContain('https://amazon-analytics-beta.vercel.app/explorer');
    });

    it('html body uses the green success color and includes the data', () => {
      expect(email.html).toContain('#15803d');
      expect(email.html).toContain('140,857');
      expect(email.html).toContain('139,201');
      expect(email.html).toContain('18h 42min');
    });

    it('html body opens with the headline + subhead', () => {
      expect(email.html).toContain('✓ Keepa enrichment completed');
      expect(email.html).toContain('Week of 2026-05-02');
    });
  });

  describe('duration formatting edge cases', () => {
    it('renders sub-minute durations as seconds', () => {
      const email = buildEnrichmentEmail({ ...baseInput, durationMs: 45_000 });
      expect(email.text).toContain('45s');
    });
    it('renders sub-hour durations as minutes only', () => {
      const email = buildEnrichmentEmail({ ...baseInput, durationMs: 25 * 60_000 });
      expect(email.text).toContain('25min');
    });
    it('renders exact-hour durations without trailing 0min', () => {
      const email = buildEnrichmentEmail({ ...baseInput, durationMs: 6 * 3_600_000 });
      expect(email.text).toContain('6h');
      expect(email.text).not.toMatch(/6h 0min/);
    });
  });

  describe('zero-percent edge cases', () => {
    it('renders 0.0% for empty status buckets without divide-by-zero', () => {
      const email = buildEnrichmentEmail({
        ...baseInput,
        counts: { active: 100, no_price: 0, delisted: 0, error: 0 },
      });
      expect(email.text).toMatch(/Active.+100.+\(100\.0%\)/);
      expect(email.text).toMatch(/No price.+0.+\(0\.0%\)/);
    });

    it('safely renders an all-zero histogram (unlikely, but possible if 0 ASINs were eligible)', () => {
      const email = buildEnrichmentEmail({
        ...baseInput,
        counts: { active: 0, no_price: 0, delisted: 0, error: 0 },
      });
      expect(email.text).toContain('0.0%');
      // Should not crash with NaN%
      expect(email.text).not.toContain('NaN');
    });
  });

  describe('html escaping', () => {
    it('escapes the weekEndDate in case anyone passes a weird value', () => {
      const email = buildEnrichmentEmail({
        ...baseInput,
        weekEndDate: '<script>alert(1)</script>',
      });
      expect(email.html).not.toContain('<script>alert(1)</script>');
      expect(email.html).toContain('&lt;script&gt;');
    });
  });
});
