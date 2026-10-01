import type { SavedViewCommandCode } from './commands';

/**
 * How the saved-view API routes answer each command failure (spec 2026-09-30 §6.1). Exhaustive by
 * type: a new code is a compile error until it is mapped here. Lives outside the routes because a
 * route file should export only handlers and route config.
 */
export const SAVED_VIEW_HTTP_STATUS = {
  invalid_id: 400,
  invalid_name: 400,
  nothing_to_update: 400,
  cap_reached: 400,
  duplicate_name: 409,
  not_found: 404,
} as const satisfies Record<SavedViewCommandCode, number>;
