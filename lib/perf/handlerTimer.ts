/**
 * Tiny server-handler timer feeding the admin <PerfPanel>. Keeps the impure
 * Date.now() reads in a plain module (out of page render bodies, where
 * react-hooks/purity flags them) and DRYs the per-step measurement: call
 * mark() after each await, then hand totalMs()/steps to PerfPanel.
 */
export interface PerfStep {
  /** Short name shown in the summary and (with a ↳ prefix) the detail row. */
  label: string;
  ms: number;
  /** Optional tag in parens, e.g. 'deferred', 'cached', 'cold'. */
  note?: string;
}

export interface HandlerTimer {
  /** Record a step = elapsed since the previous mark (or the start). */
  mark(label: string, note?: string): void;
  /** Total elapsed since the timer started. */
  totalMs(): number;
  /** Steps recorded so far (live array). */
  steps: PerfStep[];
}

export function startHandlerTimer(): HandlerTimer {
  const t0 = Date.now();
  let last = t0;
  const steps: PerfStep[] = [];
  return {
    mark(label, note) {
      const now = Date.now();
      steps.push({ label, ms: now - last, note });
      last = now;
    },
    totalMs: () => Date.now() - t0,
    steps,
  };
}
