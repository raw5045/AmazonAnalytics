import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { APPROVAL_RESULT_PREFIX, isApprovalResultMessage } from './approvalResult';

/**
 * Every way a module can pull runtime code into the browser bundle, found in its comment-stripped
 * source: (a) a line that starts an `import` (named, default, namespace or bare side-effect
 * `import '…'`) or an `export … from`, other than `import type` / `export type`; (b) any statement
 * holding `from '…'` that does not start with `import type` / `export type` — this catches a
 * multi-line import or re-export whose `from` sits on a later line; statements split at `;` and
 * before each line that starts with import/export, so a file without semicolons is covered too;
 * (c) a dynamic `import(` or a `require(`. An inline `import { type A }` is flagged on purpose:
 * whether it is erased depends on compiler settings, so it fails loud.
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

describe('approvalResult (spec 2026-10-01 §6)', () => {
  it('pins the prefix (the prompt explains it to the model; the thread and the route match on it)', () => {
    expect(APPROVAL_RESULT_PREFIX).toBe('[approval-result]');
  });
  it('isApprovalResultMessage is true for a user message whose first part is text starting with the prefix', () => {
    expect(isApprovalResultMessage({ role: 'user', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} The person denied delete_saved_view.` }] })).toBe(true);
  });
  it('isApprovalResultMessage is false for an ordinary user message, for an assistant message and for an empty message', () => {
    expect(isApprovalResultMessage({ role: 'user', parts: [{ type: 'text', text: 'please save it' }] })).toBe(false);
    expect(isApprovalResultMessage({ role: 'assistant', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} x` }] })).toBe(false);
    expect(isApprovalResultMessage({ role: 'user', parts: [] })).toBe(false);
  });
  it('has no runtime imports: browser code (Thread.tsx, arc 4 Task 8) imports this module', () => {
    expect(runtimeImports(readFileSync(path.join(__dirname, 'approvalResult.ts'), 'utf8'))).toEqual([]);
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
