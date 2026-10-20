import { describe, it, expect } from 'vitest';
import { buildImportEmail } from './buildImportEmail';

const baseInput = {
  filename: 'US_Top_Search_Terms_Simple_Week_2026_04_25.csv',
  batchId: '3cbf91d3-ae35-47be-af03-fc09bd97f252',
  appUrl: 'https://keywordquarry.com',
};

describe('buildImportEmail', () => {
  describe('completed (full success)', () => {
    const email = buildImportEmail({
      ...baseInput,
      outcome: 'completed',
      durationMs: 30 * 60 * 1000 + 36_000,
      rowsImported: 3_094_002,
      rowsInSummary: 3_882_892,
      latestWeek: '2026-04-25',
    });

    it('subject contains the filename and a check mark', () => {
      expect(email.subject).toContain('✓');
      expect(email.subject).toContain('Import succeeded');
      expect(email.subject).toContain('US_Top_Search_Terms_Simple_Week_2026_04_25.csv');
    });

    it('text body lists key metrics', () => {
      expect(email.text).toContain('completed successfully');
      expect(email.text).toContain('31 min');
      expect(email.text).toContain('3,094,002');
      expect(email.text).toContain('3,882,892');
      expect(email.text).toContain('2026-04-25');
    });

    it('text body has a link to the batch detail page', () => {
      expect(email.text).toContain(
        'https://keywordquarry.com/admin/batches/3cbf91d3-ae35-47be-af03-fc09bd97f252',
      );
    });

    it('html body includes the green headline color and the same data', () => {
      expect(email.html).toContain('#15803d');
      expect(email.html).toContain('3,094,002');
      expect(email.html).toContain('3,882,892');
    });
  });

  describe('completed_with_refresh_failure', () => {
    const email = buildImportEmail({
      ...baseInput,
      outcome: 'completed_with_refresh_failure',
      errorMessage: 'connection terminated unexpectedly',
    });

    it('subject contains warning emoji and "stale"', () => {
      expect(email.subject).toContain('⚠');
      expect(email.subject).toContain('stale');
    });

    it('text body tells admin to run refreshSummaryOnce.ts', () => {
      expect(email.text).toContain('refreshSummaryOnce.ts');
    });

    it('text body includes the refresh error message', () => {
      expect(email.text).toContain('connection terminated unexpectedly');
    });

    it('html body includes the amber headline color', () => {
      expect(email.html).toContain('#b45309');
    });
  });

  describe('failed (hard failure)', () => {
    const email = buildImportEmail({
      ...baseInput,
      outcome: 'failed',
      lastPhase: 'kwm_insert',
      errorMessage: 'COPY failed: invalid byte sequence for encoding "UTF8"',
    });

    it('subject contains the X mark', () => {
      expect(email.subject).toContain('✗');
      expect(email.subject).toContain('Import failed');
    });

    it('text body indicates data did NOT make it into kwm', () => {
      expect(email.text).toContain('did NOT make it into kwm');
      expect(email.text).toContain('Re-upload');
    });

    it('text body includes the failed phase + error', () => {
      expect(email.text).toContain('kwm_insert');
      expect(email.text).toContain('invalid byte sequence');
    });

    it('html body includes the red headline color', () => {
      expect(email.html).toContain('#b91c1c');
    });

    it('html body escapes user-supplied error messages', () => {
      const xssEmail = buildImportEmail({
        ...baseInput,
        outcome: 'failed',
        lastPhase: 'staging_copy',
        errorMessage: '<script>alert(1)</script>',
      });
      expect(xssEmail.html).not.toContain('<script>alert(1)</script>');
      expect(xssEmail.html).toContain('&lt;script&gt;');
    });
  });

  describe('batch_failed (the orchestrator finished a batch with failed files)', () => {
    const email = buildImportEmail({
      ...baseInput,
      outcome: 'batch_failed',
      failures: [
        {
          filename: 'US_Top_Search_Terms_Simple_Week_2026_04_25.csv',
          reason: 'orchestrator poll budget exhausted (>72 × 5m)',
        },
        { filename: 'US_Top_Search_Terms_Simple_Week_2026_05_02.csv', reason: null },
      ],
    });

    it('subject says FAILED and names the first failed file, plus how many more', () => {
      expect(email.subject).toBe(
        '✗ Import FAILED: US_Top_Search_Terms_Simple_Week_2026_04_25.csv (+1 more)',
      );
    });

    it('text body says the batch failed and lists each failed file with its stored reason', () => {
      expect(email.text).toContain('The import batch failed: 2 files did not import.');
      expect(email.text).toContain(
        '- US_Top_Search_Terms_Simple_Week_2026_04_25.csv: orchestrator poll budget exhausted (>72 × 5m)',
      );
      expect(email.text).toContain(
        '- US_Top_Search_Terms_Simple_Week_2026_05_02.csv: no reason recorded',
      );
    });

    it('text body gives the recovery steps and the batch link', () => {
      expect(email.text).toContain(
        'The file is still uploaded: reset it and click Import again (see memory/import-crash-2026-10-19 in the repo docs or ask the assistant)',
      );
      expect(email.text).toContain(
        'https://keywordquarry.com/admin/batches/3cbf91d3-ae35-47be-af03-fc09bd97f252',
      );
    });

    it('html body has the red headline, each failed file and its reason, and the recovery steps', () => {
      expect(email.html).toContain('#b91c1c');
      expect(email.html).toContain('Import FAILED');
      expect(email.html).toContain('US_Top_Search_Terms_Simple_Week_2026_05_02.csv');
      expect(email.html).toContain('orchestrator poll budget exhausted');
      expect(email.html).toContain('no reason recorded');
      expect(email.html).toContain('reset it and click Import again');
    });

    it('html body escapes the filenames and the stored reasons', () => {
      const xss = buildImportEmail({
        ...baseInput,
        outcome: 'batch_failed',
        failures: [{ filename: '<b>x.csv</b>', reason: '<script>alert(1)</script>' }],
      });
      expect(xss.html).not.toContain('<script>alert(1)</script>');
      expect(xss.html).toContain('&lt;script&gt;');
      expect(xss.html).not.toContain('<b>x.csv</b>');
    });

    it('one failure gets no "+N more", and a long stored reason is cut to keep the email readable', () => {
      const one = buildImportEmail({
        ...baseInput,
        outcome: 'batch_failed',
        failures: [{ filename: baseInput.filename, reason: `Failed query: ${'x'.repeat(2_000)}` }],
      });
      expect(one.subject).toBe('✗ Import FAILED: US_Top_Search_Terms_Simple_Week_2026_04_25.csv');
      expect(one.text).toContain('The import batch failed: 1 file did not import.');
      expect(one.text).toContain(`Failed query: ${'x'.repeat(100)}`);
      expect(one.text).not.toContain('x'.repeat(600));
      expect(one.text).toContain('…');
    });

    it('a batch with no failed file rows still says it failed', () => {
      const none = buildImportEmail({ ...baseInput, filename: 'batch', outcome: 'batch_failed' });
      expect(none.subject).toBe('✗ Import FAILED: batch');
      expect(none.text).toContain('The import batch failed.');
      expect(none.text).toContain('reset it and click Import again');
    });
  });

  describe('graceful handling of missing fields', () => {
    it('renders dashes for missing duration / counts', () => {
      const email = buildImportEmail({
        ...baseInput,
        outcome: 'completed',
      });
      expect(email.text).toContain('—');
    });
  });
});
