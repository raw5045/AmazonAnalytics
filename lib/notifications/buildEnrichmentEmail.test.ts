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

describe('buildEnrichmentEmail — completed variant', () => {
  const email = buildEnrichmentEmail({ ...baseInput, outcome: 'completed' });

  it('subject signals success', () => {
    expect(email.subject).toContain('✓');
    expect(email.subject).toContain('Keepa enrichment completed');
    expect(email.subject).toContain('2026-05-02');
  });

  it('text body shows duration as Xh Ymin', () => {
    expect(email.text).toContain('18h 42min');
  });

  it('text body lists ASIN totals and percentages', () => {
    expect(email.text).toContain('140,857'); // 139201+1389+198+69
    expect(email.text).toContain('139,201');
    expect(email.text).toMatch(/98\.8%/);
  });

  it('text body links to the explorer', () => {
    expect(email.text).toContain('https://amazon-analytics-beta.vercel.app/explorer');
  });

  it('html body uses the green success color', () => {
    expect(email.html).toContain('#15803d');
    expect(email.html).toContain('✓ Keepa enrichment completed');
  });
});

describe('buildEnrichmentEmail — failed variant', () => {
  const email = buildEnrichmentEmail({
    ...baseInput,
    outcome: 'failed',
    errorMessage: 'pg connection terminated unexpectedly',
  });

  it('subject signals hard failure', () => {
    expect(email.subject).toContain('✗');
    expect(email.subject).toContain('Keepa enrichment failed');
    expect(email.subject).toContain('2026-05-02');
  });

  it('text body says did not complete', () => {
    expect(email.text).toContain('did not complete');
  });

  it('text body surfaces the error message', () => {
    expect(email.text).toContain('pg connection terminated unexpectedly');
  });

  it('text body explains how to recover', () => {
    expect(email.text).toContain('Re-fire');
    expect(email.text).toContain('keepa.enrich-week-requested');
    expect(email.text).toContain('excludes already-enriched');
  });

  it('html body uses the red error color', () => {
    expect(email.html).toContain('#b91c1c');
    expect(email.html).toContain('✗ Keepa enrichment failed');
  });

  it('html body escapes user-supplied error messages', () => {
    const xss = buildEnrichmentEmail({
      ...baseInput,
      outcome: 'failed',
      errorMessage: '<script>alert(1)</script>',
    });
    expect(xss.html).not.toContain('<script>alert(1)</script>');
    expect(xss.html).toContain('&lt;script&gt;');
  });

  it('renders even without an explicit errorMessage', () => {
    const noMsg = buildEnrichmentEmail({ ...baseInput, outcome: 'failed' });
    expect(noMsg.text).toContain('(no error message captured)');
    expect(noMsg.subject).toContain('✗');
  });
});

describe('buildEnrichmentEmail — orphaned variant', () => {
  const email = buildEnrichmentEmail({
    ...baseInput,
    outcome: 'orphaned',
    errorMessage: 'Heartbeat stale > 10 min while orchestrator was waiting',
    // Counts reflect partial work
    counts: { active: 50_000, no_price: 2_000, delisted: 0, error: 0 },
    durationMs: 5 * 3_600_000, // 5h
    tokensSpent: 104_000,
  });

  it('subject signals interruption with amber tone', () => {
    expect(email.subject).toContain('⚠');
    expect(email.subject).toContain('Keepa enrichment interrupted');
    expect(email.subject).toContain('2026-05-02');
  });

  it('text body says interrupted', () => {
    expect(email.text).toContain('was interrupted');
  });

  it('text body says the data already collected is correct', () => {
    expect(email.text).toContain('correct');
    expect(email.text).toContain('Re-firing');
  });

  it('text body shows partial progress accurately', () => {
    expect(email.text).toContain('52,000'); // 50000+2000+0+0
    expect(email.text).toContain('50,000');
    expect(email.text).toContain('5h');
  });

  it('html body uses the amber warning color', () => {
    expect(email.html).toContain('#b45309');
    expect(email.html).toContain('⚠ Keepa enrichment interrupted');
  });

  it('uses a default cause description when no errorMessage given', () => {
    const noMsg = buildEnrichmentEmail({ ...baseInput, outcome: 'orphaned' });
    expect(noMsg.text).toMatch(/Worker process stopped responding/);
  });
});

describe('buildEnrichmentEmail — duration formatting edge cases', () => {
  it('renders sub-minute durations as seconds', () => {
    const email = buildEnrichmentEmail({ ...baseInput, outcome: 'completed', durationMs: 45_000 });
    expect(email.text).toContain('45s');
  });
  it('renders sub-hour durations as minutes only', () => {
    const email = buildEnrichmentEmail({ ...baseInput, outcome: 'completed', durationMs: 25 * 60_000 });
    expect(email.text).toContain('25min');
  });
  it('renders exact-hour durations without trailing 0min', () => {
    const email = buildEnrichmentEmail({ ...baseInput, outcome: 'completed', durationMs: 6 * 3_600_000 });
    expect(email.text).toContain('6h');
    expect(email.text).not.toMatch(/6h 0min/);
  });
});

describe('buildEnrichmentEmail — zero-percent edge cases', () => {
  it('renders 0.0% for empty status buckets without divide-by-zero', () => {
    const email = buildEnrichmentEmail({
      ...baseInput,
      outcome: 'completed',
      counts: { active: 100, no_price: 0, delisted: 0, error: 0 },
    });
    expect(email.text).toMatch(/Active.+100.+\(100\.0%\)/);
    expect(email.text).toMatch(/No price.+0.+\(0\.0%\)/);
  });

  it('safely renders an all-zero histogram without NaN', () => {
    const email = buildEnrichmentEmail({
      ...baseInput,
      outcome: 'orphaned',
      counts: { active: 0, no_price: 0, delisted: 0, error: 0 },
    });
    expect(email.text).toContain('0.0%');
    expect(email.text).not.toContain('NaN');
  });
});

describe('buildEnrichmentEmail — html escaping', () => {
  it('escapes the weekEndDate', () => {
    const email = buildEnrichmentEmail({
      ...baseInput,
      outcome: 'completed',
      weekEndDate: '<script>alert(1)</script>',
    });
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
