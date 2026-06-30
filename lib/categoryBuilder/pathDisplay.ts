import { PATH_SEP } from './buildTree';

/** Split a full category path into its leaf (last segment) and parent prefix. */
export function splitCategoryPath(path: string): { leaf: string; prefix: string } {
  const segs = path.split(PATH_SEP);
  const leaf = segs[segs.length - 1] ?? path;
  const prefix = segs.slice(0, -1).join(PATH_SEP);
  return { leaf, prefix };
}
