// Stub for `server-only` so vitest can resolve the import in modules
// that use it. pnpm's strict node_modules layout hides this transitive
// dep of next from vite's import-analysis. Aliased in vitest.config.ts.
export {};
