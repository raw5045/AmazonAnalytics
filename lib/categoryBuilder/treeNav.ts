import { type CategoryNode, collectDescendantLeaves, PATH_SEP } from './buildTree';

/** One drill-down level sent to the client — no nested children. */
export interface LightNode {
  name: string;
  hasChildren: boolean;
  terminal: boolean;
}

/** `path` query param (names joined by PATH_SEP) → trimmed segment array. */
export function parsePathParam(param: string | null): string[] {
  if (!param) return [];
  return param.split(PATH_SEP).map((s) => s.trim()).filter(Boolean);
}

/** Walk to the node at `path`; 'root' for empty path, undefined if a segment is missing. */
function nodeAtPath(tree: CategoryNode[], path: string[]): CategoryNode | 'root' | undefined {
  if (path.length === 0) return 'root';
  let level = tree;
  let node: CategoryNode | undefined;
  for (const name of path) {
    node = level.find((n) => n.name === name);
    if (!node) return undefined;
    level = node.children;
  }
  return node;
}

/** Children of the node at `path` as LightNodes. Empty path → root departments. */
export function childrenAtPath(tree: CategoryNode[], path: string[]): LightNode[] {
  const target = nodeAtPath(tree, path);
  if (target === undefined) return [];
  const level = target === 'root' ? tree : target.children;
  return level.map((n) => ({ name: n.name, hasChildren: n.children.length > 0, terminal: n.terminal }));
}

/** All terminal leaf names under `path` (deduped, locale-sorted). */
export function leavesAtPath(tree: CategoryNode[], path: string[]): string[] {
  const target = nodeAtPath(tree, path);
  if (target === undefined) return [];
  if (target === 'root') {
    return Array.from(new Set(tree.flatMap((n) => collectDescendantLeaves(n)))).sort((a, b) => a.localeCompare(b));
  }
  return collectDescendantLeaves(target);
}
