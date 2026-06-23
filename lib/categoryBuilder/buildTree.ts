/**
 * Pure, dependency-free category-tree builder.
 *
 * A node is **terminal** when at least one input path ends exactly at that
 * node's depth (i.e. the node is the last segment of that path). Critically,
 * a node can be BOTH terminal AND a parent: if one Keepa breadcrumb ends at
 * "Vitamins" while another continues to "Vitamins › Collagen", then the
 * "Vitamins" node has `terminal = true` AND has children. `collectDescendantLeaves`
 * honours this by including the node's own name whenever `terminal = true`,
 * even when children also exist.
 */

export const PATH_SEP = ' › ';

export interface CategoryNode {
  name: string;
  children: CategoryNode[];
  terminal: boolean;
}

/**
 * Build a nested category tree from an array of ` › `-delimited breadcrumb
 * paths. Shared prefixes are merged into a single node. Children at every
 * level are sorted by name (locale-aware). Blank / whitespace-only paths are
 * silently ignored.
 */
export function buildTree(paths: string[]): CategoryNode[] {
  // Use an internal map-of-maps structure during construction, then convert.
  // Each entry: { node, childrenByName }
  interface Entry {
    node: CategoryNode;
    childrenByName: Map<string, Entry>;
  }

  const rootsByName = new Map<string, Entry>();

  for (const raw of paths) {
    if (!raw.trim()) continue;

    const segments = raw
      .split(PATH_SEP)
      .map((s) => s.trim())
      .filter(Boolean);

    if (segments.length === 0) continue;

    let currentMap = rootsByName;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      if (!currentMap.has(seg)) {
        const node: CategoryNode = { name: seg, children: [], terminal: false };
        currentMap.set(seg, { node, childrenByName: new Map() });
      }

      const entry = currentMap.get(seg)!;

      if (isLast) {
        entry.node.terminal = true;
      }

      currentMap = entry.childrenByName;
    }
  }

  // Recursively convert the entry tree into sorted CategoryNode trees.
  function toSortedNodes(map: Map<string, Entry>): CategoryNode[] {
    const nodes = Array.from(map.values()).map((entry) => {
      entry.node.children = toSortedNodes(entry.childrenByName);
      return entry.node;
    });
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
  }

  return toSortedNodes(rootsByName);
}

/**
 * DFS the subtree rooted at `node`, collecting the `name` of every node where
 * `terminal === true` — including `node` itself if it is terminal. Returns a
 * deduped, locale-sorted array.
 *
 * Because a node can be both terminal AND a parent, descending never stops
 * at a terminal node; it continues into children as well.
 */
export function collectDescendantLeaves(node: CategoryNode): string[] {
  const names = new Set<string>();

  function dfs(n: CategoryNode): void {
    if (n.terminal) {
      names.add(n.name);
    }
    for (const child of n.children) {
      dfs(child);
    }
  }

  dfs(node);
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}
