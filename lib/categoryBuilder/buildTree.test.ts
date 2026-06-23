import { describe, it, expect } from 'vitest';
import { buildTree, collectDescendantLeaves, type CategoryNode } from './buildTree';

const SEP = ' › ';

describe('buildTree', () => {
  it('builds a nested tree, roots sorted, merging shared prefixes', () => {
    const tree = buildTree([
      `Health & Household${SEP}Vitamins${SEP}Collagen`,
      `Health & Household${SEP}Vitamins${SEP}Iron`,
      `Beauty${SEP}Skin Care`,
    ]);
    expect(tree.map((n) => n.name)).toEqual(['Beauty', 'Health & Household']);
    const hh = tree.find((n) => n.name === 'Health & Household')!;
    expect(hh.children.map((n) => n.name)).toEqual(['Vitamins']);
    expect(hh.children[0].children.map((n) => n.name)).toEqual(['Collagen', 'Iron']);
  });

  it('marks a node terminal when a path ends exactly there (even if it also has children)', () => {
    const tree = buildTree([
      `Health & Household${SEP}Vitamins`,
      `Health & Household${SEP}Vitamins${SEP}Collagen`,
    ]);
    const vit = tree[0].children[0];
    expect(vit.name).toBe('Vitamins');
    expect(vit.terminal).toBe(true);
    expect(vit.children.map((n) => n.name)).toEqual(['Collagen']);
  });

  it('ignores empty/blank paths', () => {
    expect(buildTree(['', '   '])).toEqual([]);
  });
});

describe('collectDescendantLeaves', () => {
  it('returns every terminal name in the subtree, including the node itself, deduped + sorted', () => {
    const [hh] = buildTree([
      `Health & Household${SEP}Vitamins`,
      `Health & Household${SEP}Vitamins${SEP}Collagen`,
      `Health & Household${SEP}Vitamins${SEP}Iron`,
    ]);
    expect(collectDescendantLeaves(hh)).toEqual(['Collagen', 'Iron', 'Vitamins']);
  });

  it('a pure leaf returns just itself', () => {
    const node: CategoryNode = { name: 'Collagen', children: [], terminal: true };
    expect(collectDescendantLeaves(node)).toEqual(['Collagen']);
  });

  it('a non-terminal parent excludes its own name', () => {
    const [root] = buildTree([`Dept${SEP}Sub${SEP}Leaf`]);
    expect(collectDescendantLeaves(root)).toEqual(['Leaf']);
  });
});
