export type JumpMetric = 'rank' | 'volume';

export interface JumpPreset {
  id: string;
  label: string;
  from: number;
  to: number;
}

export const RANK_JUMP_PRESETS: readonly JumpPreset[] = [
  { id: '500k_to_100k', label: '500k → 100k', from: 500_000, to: 100_000 },
  { id: '100k_to_50k',  label: '100k → 50k',  from: 100_000, to: 50_000 },
  { id: '100k_to_10k',  label: '100k → 10k',  from: 100_000, to: 10_000 },
  { id: '50k_to_10k',   label: '50k → 10k',   from: 50_000,  to: 10_000 },
];

export const VOLUME_JUMP_PRESETS: readonly JumpPreset[] = [
  { id: 'v5k_to_15k',   label: 'Under 5k → over 15k',   from: 5_000,  to: 15_000 },
  { id: 'v15k_to_30k',  label: 'Under 15k → over 30k',  from: 15_000, to: 30_000 },
  { id: 'v30k_to_100k', label: 'Under 30k → over 100k', from: 30_000, to: 100_000 },
  { id: 'v15k_to_100k', label: 'Under 15k → over 100k', from: 15_000, to: 100_000 },
];

export function jumpPresetsFor(metric: JumpMetric): readonly JumpPreset[] {
  return metric === 'volume' ? VOLUME_JUMP_PRESETS : RANK_JUMP_PRESETS;
}

export function findJumpPreset(id: string): { metric: JumpMetric; preset: JumpPreset } | null {
  const r = RANK_JUMP_PRESETS.find((p) => p.id === id);
  if (r) return { metric: 'rank', preset: r };
  const v = VOLUME_JUMP_PRESETS.find((p) => p.id === id);
  if (v) return { metric: 'volume', preset: v };
  return null;
}
