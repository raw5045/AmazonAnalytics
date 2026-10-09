// lib/research/productCaps.ts
/**
 * get_product_details' answer caps (spec 2026-10-09 §9). Import-free, like ./defaults.ts, so the
 * tool definitions (./tools.ts, which lib/workspace/tools.ts and the Ask approval modules load
 * without lib/env) can build their descriptions from them; ./products.ts applies them and
 * re-exports both.
 */

/** The keyword list cap: the page shows up to 500, a tool answer stays smaller. keywordsTotal still counts them all. */
export const PRODUCT_TOOL_KEYWORDS_CAP = 100;

/**
 * The history points: the newest 60 snapshots (about a year of weekly fetches), still oldest
 * first. The loader reads its own window of up to PRODUCT_HISTORY_CAP (400, the page's charts);
 * `first`, `last` and `pointsTotal` describe that whole window, so a then-and-now still reaches
 * back past the points a tool answer carries.
 */
export const PRODUCT_TOOL_HISTORY_POINTS = 60;
