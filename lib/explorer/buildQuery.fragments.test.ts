import { describe, it, expect } from 'vitest';
import {
  leafPathPredicate,
  severityPredicate,
  slotColumn,
  WINDOW_TO_RANK_COLUMN,
  WINDOW_TO_VOLUME_COLUMN,
  type NextParam,
} from './buildQuery';

/** Numbered-param binder identical to the one buildExplorerQuery uses. */
function binder() {
  const args: unknown[] = [];
  const next: NextParam = (v) => {
    args.push(v);
    return `$${args.length}`;
  };
  return { args, next };
}

describe('exported Explorer fragments (reused by lib/research/query.ts)', () => {
  it('leafPathPredicate binds every path in order and is null without paths', () => {
    const { args, next } = binder();
    expect(leafPathPredicate({ leafPaths: ['A › B', 'C › D'] }, next)).toBe('kcs.top_clicked_category_path IN ($1, $2)');
    expect(args).toEqual(['A › B', 'C › D']);
    expect(leafPathPredicate({ leafPaths: [] }, binder().next)).toBeNull();
  });

  it('severityPredicate keeps NULL rows only when "none" is selected, and is null for all three', () => {
    let b = binder();
    expect(severityPredicate({ severities: ['none', 'warning'] }, b.next)).toBe(
      '(kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN ($1, $2))',
    );
    expect(b.args).toEqual(['none', 'warning']);
    b = binder();
    expect(severityPredicate({ severities: ['critical'] }, b.next)).toBe('kcs.fake_volume_severity_current IN ($1)');
    expect(severityPredicate({ severities: ['none', 'warning', 'critical'] }, binder().next)).toBeNull();
    expect(severityPredicate({ severities: [] }, binder().next)).toBeNull();
  });

  it('slotColumn picks the loose or strict in-title flag column', () => {
    expect(slotColumn(2, 'loose')).toBe('kcs.keyword_in_title_2_loose_current');
    expect(slotColumn(3, 'strict')).toBe('kcs.keyword_in_title_3_current');
  });

  it('window maps name the stored prior-rank and prior-volume columns', () => {
    expect(WINDOW_TO_RANK_COLUMN).toEqual({ '1w': 'prior_week_rank', '4w': 'rank_4w_ago', '13w': 'rank_13w_ago', '26w': 'rank_26w_ago', '52w': 'rank_52w_ago' });
    expect(WINDOW_TO_VOLUME_COLUMN).toEqual({ '1w': 'estimated_monthly_volume_1w_ago', '4w': 'estimated_monthly_volume_4w_ago', '13w': 'estimated_monthly_volume_13w_ago', '26w': 'estimated_monthly_volume_26w_ago', '52w': 'estimated_monthly_volume_52w_ago' });
  });
});
