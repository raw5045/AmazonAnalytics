/**
 * The message an import failure left on uploaded_files.validation_errors_json,
 * or null when there is none.
 *
 * Validation failures store `{ errors: [...], total }` and their rows also land
 * in ingestion_errors, which the page already lists. Import-side failures (the
 * worker's catch path, the orchestrator's poll-budget timeout, the skipped-after
 * marker, the recovery scripts) store `{ error: string, ...context }` instead and
 * write nothing to ingestion_errors, so without this the reason never reaches
 * the page.
 */
export function importErrorMessage(json: unknown): string | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const error = (json as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : null;
}
