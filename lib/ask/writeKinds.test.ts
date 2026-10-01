import { describe, it, expect } from 'vitest';
import { CHANGE_TOOLS, DELETE_TOOLS, writeKind } from './writeKinds';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';

describe('writeKinds (spec 2026-10-01 §3)', () => {
  it('classifies every workspace tool as a list, a change or a delete, in step with the definitions\' requiresConfirmation', () => {
    for (const d of WORKSPACE_TOOLS) {
      const kind = writeKind(d.name);
      expect(kind === null).toBe(!d.requiresConfirmation);
      if (kind === 'delete') expect(DELETE_TOOLS.has(d.name)).toBe(true);
      if (kind === 'change') expect(CHANGE_TOOLS.has(d.name)).toBe(true);
    }
    expect([...DELETE_TOOLS].sort()).toEqual(['delete_custom_category', 'delete_saved_view']);
    expect(CHANGE_TOOLS.size + DELETE_TOOLS.size).toBe(WORKSPACE_TOOLS.filter((d) => d.requiresConfirmation).length);
  });
  it('is null for a research tool or an unknown name — never throws', () => {
    expect(writeKind('search_keywords')).toBeNull();
    expect(writeKind('not_a_tool')).toBeNull();
  });
});
