/**
 * Unit tests for the trigram-GIN rotation logic in refreshSummary.
 *
 * The names of the search_term_normalized GIN must ALTERNATE across each weekly
 * stage/live RENAME swap, because index objects travel with their heap through
 * the swap. A fixed name built on _stage would collide with the same-named index
 * that just rotated onto the live table. pickStageGinName encodes that choice;
 * these tests pin every branch so a regression can't silently reintroduce the
 * collision.
 */
import { describe, it, expect } from 'vitest';
import { pickStageGinName, KCS_NORM_GIN_A, KCS_NORM_GIN_B } from './refreshSummary';

describe('pickStageGinName', () => {
  it('builds B when A is live', () => {
    expect(pickStageGinName(KCS_NORM_GIN_A)).toBe(KCS_NORM_GIN_B);
  });

  it('builds A when B is live', () => {
    expect(pickStageGinName(KCS_NORM_GIN_B)).toBe(KCS_NORM_GIN_A);
  });

  it('builds A when live has no GIN yet (null) — the cold-start / post-migration seed', () => {
    expect(pickStageGinName(null)).toBe(KCS_NORM_GIN_A);
  });

  it('builds A when live has no GIN yet (undefined)', () => {
    expect(pickStageGinName(undefined)).toBe(KCS_NORM_GIN_A);
  });

  it('builds A for any unexpected live name — self-heals back into the A/B rotation', () => {
    expect(pickStageGinName('some_legacy_gin_idx')).toBe(KCS_NORM_GIN_A);
  });

  it('the two rotation names are distinct', () => {
    expect(KCS_NORM_GIN_A).not.toBe(KCS_NORM_GIN_B);
  });

  it('alternates indefinitely when fed its own output (live ← prior build)', () => {
    // Simulate successive refreshes: each builds onto stage, swaps → that name
    // becomes the live name the next refresh sees. Must ping-pong A/B forever.
    let live: string | null = null; // post-migration: no GIN anywhere
    const built: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = pickStageGinName(live);
      built.push(name);
      live = name; // the just-built stage index rotates onto live at swap
    }
    expect(built).toEqual([
      KCS_NORM_GIN_A,
      KCS_NORM_GIN_B,
      KCS_NORM_GIN_A,
      KCS_NORM_GIN_B,
      KCS_NORM_GIN_A,
      KCS_NORM_GIN_B,
    ]);
  });
});
