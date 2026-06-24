import { describe, it, expect } from 'vitest';
import { buildTree } from './buildTree';
import { childrenAtPath, leavesAtPath, parsePathParam } from './treeNav';

const tree = buildTree([
  'Books › Fiction',
  'Books › Nonfiction › History',
  'Books › Nonfiction', // makes "Nonfiction" terminal AND a parent
  'Electronics',
]);

describe('parsePathParam', () => {
  it('null/empty → []', () => {
    expect(parsePathParam(null)).toEqual([]);
    expect(parsePathParam('')).toEqual([]);
  });
  it('splits on the " › " separator and trims blanks', () => {
    expect(parsePathParam('Books › Nonfiction')).toEqual(['Books', 'Nonfiction']);
  });
});

describe('childrenAtPath', () => {
  it('empty path → root departments as LightNodes', () => {
    expect(childrenAtPath(tree, [])).toEqual([
      { name: 'Books', hasChildren: true, terminal: false },
      { name: 'Electronics', hasChildren: false, terminal: true },
    ]);
  });
  it('drills one level', () => {
    expect(childrenAtPath(tree, ['Books'])).toEqual([
      { name: 'Fiction', hasChildren: false, terminal: true },
      { name: 'Nonfiction', hasChildren: true, terminal: true },
    ]);
  });
  it('unresolved path → []', () => {
    expect(childrenAtPath(tree, ['Nope'])).toEqual([]);
  });
});

describe('leavesAtPath', () => {
  it('collects terminal names under a path (incl. self if terminal)', () => {
    expect(leavesAtPath(tree, ['Books', 'Nonfiction'])).toEqual(['History', 'Nonfiction']);
  });
  it('leaf node → just itself', () => {
    expect(leavesAtPath(tree, ['Electronics'])).toEqual(['Electronics']);
  });
  it('unresolved path → []', () => {
    expect(leavesAtPath(tree, ['Nope'])).toEqual([]);
  });
});
