import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { summarizeApproval, TITLES } from './approvalSummaries';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';

/**
 * A copy of the guard in approvalResult.test.ts — keep the two identical (one shared helper is a
 * follow-up). Every way a module can pull runtime code into the browser bundle, found in its
 * comment-stripped source: (a) a line that starts an `import` (named, default, namespace or bare
 * side-effect `import '…'`) or an `export … from`, other than `import type` / `export type`;
 * (b) any statement holding `from '…'` that does not start with `import type` / `export type` —
 * this catches a multi-line import or re-export whose `from` sits on a later line; statements
 * split at `;` and before each line that starts with import/export, so a file without semicolons
 * is covered too; (c) a dynamic `import(` or a `require(`. An inline `import { type A }` is
 * flagged on purpose: whether it is erased depends on compiler settings, so it fails loud.
 */
function runtimeImports(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const typeOnly = /^\s*(import|export)\s+type\b/;
  const lines = code.split(/\r?\n/).filter((l) =>
    (/^\s*import(?=[\s{*'"])/.test(l) || /^\s*export\b.*\bfrom\s*['"]/.test(l)) && !typeOnly.test(l));
  const statements = code.split(/;|\r?\n(?=\s*(?:import|export)\b)/).filter((s) => /\bfrom\s*['"]/.test(s) && !typeOnly.test(s));
  const calls = code.match(/\b(?:import|require)\s*\(/g) ?? [];
  return [...lines, ...statements, ...calls];
}

const names = { views: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Lamps' }, categories: { 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 'Lighting' } };
const VIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const titleOf = (name: string) => WORKSPACE_TOOLS.find((d) => d.name === name)!.title;

describe('summarizeApproval (spec 2026-10-01 §5)', () => {
  it('saved views', () => {
    expect(summarizeApproval('create_saved_view', { name: 'Lamps under 500 reviews', search: {} }, names)).toBe('Save a view named ‘Lamps under 500 reviews’');
    expect(summarizeApproval('update_saved_view', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Desk lamps' }, names)).toBe('Rename the view ‘Lamps’ to ‘Desk lamps’');
    expect(summarizeApproval('update_saved_view', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', search: {} }, names)).toBe('Replace the filters of the view ‘Lamps’');
    expect(summarizeApproval('update_saved_view', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'X', search: {} }, names)).toBe('Rename the view ‘Lamps’ to ‘X’ and replace its filters');
    expect(summarizeApproval('delete_saved_view', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, names)).toBe('Delete the view ‘Lamps’ — permanent');
    expect(summarizeApproval('delete_saved_view', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, names)).toBe('Delete the view …cccccccc — permanent');
  });
  it('custom categories', () => {
    expect(summarizeApproval('create_custom_category', { name: 'Lighting', categories: { selections: [{ kind: 'taxonomy', path: 'A' }, { kind: 'taxonomy', path: 'B' }], leafPaths: [] } }, names)).toBe('Create the category ‘Lighting’ from 2 selections');
    expect(summarizeApproval('create_custom_category', { name: 'Lighting', categories: { selections: [], leafPaths: ['A › B'] } }, names)).toBe('Create the category ‘Lighting’ from 1 leaf path');
    expect(summarizeApproval('update_custom_category', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', categories: { selections: [{ kind: 'taxonomy', path: 'A' }], leafPaths: [] }, leafMode: 'add' }, names)).toBe('Change the category ‘Lighting’: add 1 selection');
    expect(summarizeApproval('update_custom_category', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', categories: { selections: [], leafPaths: ['A › B', 'A › C'] }, leafMode: 'remove' }, names)).toBe('Change the category ‘Lighting’: remove 2 leaf paths');
    expect(summarizeApproval('update_custom_category', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Lamps & lights' }, names)).toBe('Rename the category ‘Lighting’ to ‘Lamps & lights’');
    expect(summarizeApproval('delete_custom_category', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, names)).toBe('Delete the category ‘Lighting’ — permanent; saved views that filter on it lose that filter');
  });
  it('watchlist, with the first three items listed', () => {
    expect(summarizeApproval('add_to_watchlist', { keywords: ['desk lamp', 'floor lamp', 'led strip', 'bulb'], searchTermIds: [] }, names)).toBe('Add 4 keywords to the watchlist: desk lamp, floor lamp, led strip (+1)');
    expect(summarizeApproval('add_to_watchlist', { keywords: [], searchTermIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }, names)).toBe('Add 1 keyword to the watchlist');
    expect(summarizeApproval('remove_from_watchlist', { keywords: ['desk lamp'], searchTermIds: [] }, names)).toBe('Remove 1 keyword from the watchlist: desk lamp');
  });
  it('never throws on malformed input — falls back to the tool\'s title', () => {
    const title = (name: string) => WORKSPACE_TOOLS.find((d) => d.name === name)!.title;
    expect(summarizeApproval('create_saved_view', null, names)).toBe(title('create_saved_view'));
    expect(summarizeApproval('add_to_watchlist', { keywords: 'nope' }, names)).toBe(title('add_to_watchlist'));
    expect(summarizeApproval('not_a_tool', {}, names)).toBe('not_a_tool');
  });
  it('TITLES is exactly the workspace definitions\' titles (the module cannot import them: it is imported by browser code)', () => {
    expect(TITLES).toEqual(Object.fromEntries(WORKSPACE_TOOLS.map((d) => [d.name, d.title])));
    expect(Object.isFrozen(TITLES)).toBe(true);
  });

  it('update_custom_category: leafMode in words (replace is the schema default), and a rename with a leaf change says both', () => {
    const two = { selections: [{ kind: 'taxonomy', path: 'Tools & Home Improvement › Lighting', includeDescendants: true }, { kind: 'custom', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }], leafPaths: [] };
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, categories: two }, names)).toBe('Change the category ‘Lighting’: replace its leaves with 2 selections');
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, categories: two, leafMode: 'replace' }, names)).toBe('Change the category ‘Lighting’: replace its leaves with 2 selections');
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, name: 'Lamps', categories: { selections: [{ kind: 'taxonomy', path: 'A' }], leafPaths: [] }, leafMode: 'add' }, names)).toBe('Rename the category ‘Lighting’ to ‘Lamps’ and add 1 selection');
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, name: 'Lamps', categories: { selections: [], leafPaths: ['A › B'] } }, names)).toBe('Rename the category ‘Lighting’ to ‘Lamps’ and replace its leaves with 1 leaf path');
    // The parsed shape: the schema fills in leafMode 'replace', so a rename-only call carries it too.
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, name: 'Lamps & lights', leafMode: 'replace' }, names)).toBe('Rename the category ‘Lighting’ to ‘Lamps & lights’');
  });
  it('counts selections and leaf paths together, and only well-formed items', () => {
    expect(summarizeApproval('create_custom_category', { name: 'Lighting', categories: { selections: [{ kind: 'taxonomy', path: 'A' }, { kind: 'custom', id: CATEGORY_ID }], leafPaths: ['A › B'] } }, names)).toBe('Create the category ‘Lighting’ from 2 selections and 1 leaf path');
    expect(summarizeApproval('create_custom_category', { name: '  Lighting ', categories: { selections: [null, 'A', { kind: 'taxonomy', path: 'A' }], leafPaths: [7, 'A › B', 'A › C'] } }, names)).toBe('Create the category ‘Lighting’ from 1 selection and 2 leaf paths');
  });
  it('shows an id\'s last 8 characters until the member\'s lists load, and finds an uppercase id', () => {
    const loading = { views: {}, categories: {} };
    expect(summarizeApproval('update_saved_view', { id: VIEW_ID, name: 'Desk lamps' }, loading)).toBe('Rename the view …aaaaaaaa to ‘Desk lamps’');
    expect(summarizeApproval('update_custom_category', { id: CATEGORY_ID, name: 'Lamps' }, loading)).toBe('Rename the category …bbbbbbbb to ‘Lamps’');
    expect(summarizeApproval('delete_custom_category', { id: CATEGORY_ID.toUpperCase() }, names)).toBe('Delete the category ‘Lighting’ — permanent; saved views that filter on it lose that filter');
  });
  it('watchlist: ids count toward the total and the (+N), exactly three texts show no (+N), non-strings are skipped', () => {
    expect(summarizeApproval('add_to_watchlist', { keywords: ['desk lamp'], searchTermIds: [VIEW_ID, CATEGORY_ID] }, names)).toBe('Add 3 keywords to the watchlist: desk lamp (+2)');
    expect(summarizeApproval('remove_from_watchlist', { keywords: ['desk lamp', 'floor lamp', 'led strip'], searchTermIds: [] }, names)).toBe('Remove 3 keywords from the watchlist: desk lamp, floor lamp, led strip');
    expect(summarizeApproval('add_to_watchlist', { keywords: ['desk lamp', 5, null], searchTermIds: 'nope' }, names)).toBe('Add 1 keyword to the watchlist: desk lamp');
  });
  it('falls back to the title when the input lacks what the line needs: a name, an id, a change, at least one item', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['create_saved_view', { name: '   ', search: {} }],
      ['update_saved_view', { id: VIEW_ID }],
      ['update_saved_view', { name: 'X', search: {} }],
      ['delete_saved_view', {}],
      ['delete_saved_view', [VIEW_ID]],
      ['delete_saved_view', VIEW_ID],
      ['create_custom_category', { name: 'Lighting', categories: { selections: [], leafPaths: [] } }],
      ['create_custom_category', { name: 'Lighting' }],
      ['create_custom_category', { categories: { selections: [], leafPaths: ['A › B'] } }],
      ['update_custom_category', { id: CATEGORY_ID, leafMode: 'add' }],
      ['update_custom_category', { id: CATEGORY_ID, categories: { selections: [], leafPaths: [] } }],
      ['update_custom_category', { name: 'X', categories: { selections: [], leafPaths: ['A › B'] } }],
      ['delete_custom_category', { id: '' }],
      ['remove_from_watchlist', { keywords: [], searchTermIds: [] }],
    ];
    for (const [tool, input] of cases) expect(summarizeApproval(tool, input, names), `${tool} ${JSON.stringify(input)}`).toBe(titleOf(tool));
  });
  it('a list tool reads as its title, and only own entries of TITLES and the names maps count, never inherited ones', () => {
    expect(summarizeApproval('list_saved_views', {}, names)).toBe('List saved views');
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(summarizeApproval(n, {}, names)).toBe(n);
    expect(summarizeApproval('delete_saved_view', { id: 'constructor' }, names)).toBe('Delete the view …structor — permanent');
    const inherited = { views: Object.create({ [VIEW_ID]: 'Inherited' }) as Record<string, string>, categories: {} };
    expect(summarizeApproval('delete_saved_view', { id: VIEW_ID }, inherited)).toBe('Delete the view …aaaaaaaa — permanent');
  });
  it('an input or a names map that throws on access falls back to the title', () => {
    const hostile = { get name(): string { throw new Error('boom'); } };
    expect(summarizeApproval('create_saved_view', hostile, names)).toBe('Create saved view');
    const broken = { get views(): Record<string, string> { throw new Error('boom'); }, categories: {} };
    expect(summarizeApproval('delete_saved_view', { id: VIEW_ID }, broken)).toBe('Delete saved view');
  });

  it('has no runtime imports: browser code (ApprovalCard, arc 4 Task 8) imports this module', () => {
    expect(runtimeImports(readFileSync(path.join(__dirname, 'approvalSummaries.ts'), 'utf8'))).toEqual([]);
  });
  it('the guard is not vacuous: it flags every way to pull in runtime code, never a type-only import or a comment', () => {
    const flagged = [
      "import { a } from './a';",
      "import './a';",
      "import a from './a';",
      "import * as a from './a';",
      "import { type A } from './a';",
      "import {\n  a,\n} from './a';",
      "export { a } from './a';",
      "export * from './a';",
      "export {\n  a,\n} from './a';",
      "import type { A } from './a'\nexport {\n  b,\n} from './b'",
      "const a = await import('./a');",
      "const a = require('./a');",
    ];
    for (const s of flagged) expect(runtimeImports(s), s).not.toEqual([]);
    const clean = [
      "import type { A } from './a';",
      "export type { A } from './a';",
      "import type {\n  A,\n} from './a';",
      "// import { a } from './a';\n/* const b = require('./b'); import('./c'); */\nexport const A = Array.from('abc');",
    ];
    for (const s of clean) expect(runtimeImports(s), s).toEqual([]);
  });
});
