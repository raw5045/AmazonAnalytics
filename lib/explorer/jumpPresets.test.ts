import { describe, it, expect } from 'vitest';
import { RANK_JUMP_PRESETS, VOLUME_JUMP_PRESETS, jumpPresetsFor, findJumpPreset } from './jumpPresets';

describe('jumpPresets', () => {
  it('exposes the four volume presets with correct thresholds', () => {
    expect(VOLUME_JUMP_PRESETS.map((p) => [p.id, p.from, p.to])).toEqual([
      ['v5k_to_15k', 5000, 15000],
      ['v15k_to_30k', 15000, 30000],
      ['v30k_to_100k', 30000, 100000],
      ['v15k_to_100k', 15000, 100000],
    ]);
  });
  it('keeps the four rank presets', () => {
    expect(RANK_JUMP_PRESETS.map((p) => p.id)).toEqual([
      '500k_to_100k', '100k_to_50k', '100k_to_10k', '50k_to_10k',
    ]);
  });
  it('jumpPresetsFor returns the metric-appropriate list', () => {
    expect(jumpPresetsFor('volume')).toBe(VOLUME_JUMP_PRESETS);
    expect(jumpPresetsFor('rank')).toBe(RANK_JUMP_PRESETS);
  });
  it('findJumpPreset infers metric from id', () => {
    expect(findJumpPreset('v15k_to_30k')?.metric).toBe('volume');
    expect(findJumpPreset('100k_to_50k')?.metric).toBe('rank');
    expect(findJumpPreset('nope')).toBeNull();
  });
});
