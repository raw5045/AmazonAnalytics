/**
 * Process-level identifiers, generated once per Node process start.
 *
 * Used to detect "did the worker process die between when we acquired
 * the lock and when we tried to recover?" — by recording BOOT_ID on
 * uploaded_files at lock-acquire time and comparing to the live worker's
 * BOOT_ID via the /health endpoint or directly in code.
 *
 * If a row's stored BOOT_ID differs from the running worker's BOOT_ID,
 * we know the original worker is gone (process exit, container restart,
 * OOM kill, etc.).
 */
import { randomUUID } from 'node:crypto';

export const BOOT_ID = randomUUID();
export const BOOTED_AT = new Date();
