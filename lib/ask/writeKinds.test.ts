import { describe, it, expect } from 'vitest';
import { CHANGE_TOOLS, DELETE_TOOLS, writeKind } from './writeKinds';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';

describe('writeKinds (spec 2026-10-01 §3)', () => {
  it('pins the six changes and the two deletes exactly, and names each one\'s kind', () => {
    expect([...CHANGE_TOOLS].sort()).toEqual(['add_to_watchlist', 'create_custom_category', 'create_saved_view', 'remove_from_watchlist', 'update_custom_category', 'update_saved_view']);
    expect([...DELETE_TOOLS].sort()).toEqual(['delete_custom_category', 'delete_saved_view']);
    for (const n of CHANGE_TOOLS) expect(writeKind(n)).toBe('change');
    for (const n of DELETE_TOOLS) expect(writeKind(n)).toBe('delete');
  });
  it('stays in step with the definitions\' requiresConfirmation both ways: every write is classified, and every classified name is a write', () => {
    for (const d of WORKSPACE_TOOLS) expect(writeKind(d.name) === null).toBe(!d.requiresConfirmation);
    for (const n of [...CHANGE_TOOLS, ...DELETE_TOOLS]) expect(WORKSPACE_TOOLS.find((d) => d.name === n)?.requiresConfirmation).toBe(true);
    expect(CHANGE_TOOLS.size + DELETE_TOOLS.size).toBe(WORKSPACE_TOOLS.filter((d) => d.requiresConfirmation).length);
  });
  it('is null for a research tool or an unknown name — never throws', () => {
    expect(writeKind('search_keywords')).toBeNull();
    expect(writeKind('not_a_tool')).toBeNull();
  });
});
