import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { APPROVAL_RESULT_PREFIX, isApprovalResultMessage } from './approvalResult';

/**
 * The lines that start a runtime import: an `import` that is not `import type` (a multi-line one
 * is caught by its first line), a side-effect import, or an `export … from` that is not
 * `export type`. Type-only imports are erased, so they never reach the browser bundle.
 */
function runtimeImportLines(src: string): string[] {
  return src.split(/\r?\n/).filter((l) =>
    (/^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l))
    || (/^\s*export\b.*\bfrom\s*['"]/.test(l) && !/^\s*export\s+type\b/.test(l)));
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
  it('has no runtime imports: browser code (Thread.tsx) imports this module', () => {
    expect(runtimeImportLines(readFileSync(path.join(__dirname, 'approvalResult.ts'), 'utf8'))).toEqual([]);
    // The guard is not vacuous: it flags a runtime import, a side-effect import and a re-export, never a type-only one.
    expect(runtimeImportLines("import { a } from './a';\nimport type { B } from './b';\nimport './c';\nexport { d } from './d';\nexport type { E } from './e';"))
      .toEqual(["import { a } from './a';", "import './c';", "export { d } from './d';"]);
  });
});
