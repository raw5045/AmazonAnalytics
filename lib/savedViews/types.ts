import type { ExplorerFilters } from '@/lib/explorer/types';

/**
 * Wire-shape of a saved view as returned by the API and consumed by
 * client components. Dates serialized as ISO strings.
 */
export interface SavedView {
  id: string;
  name: string;
  filters: ExplorerFilters;
  createdAt: string;
  updatedAt: string;
}
