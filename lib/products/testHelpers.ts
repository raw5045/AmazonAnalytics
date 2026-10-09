// lib/products/testHelpers.ts
/**
 * Helpers shared by the lib/products SQL tests: pinning a statement's columns against the drizzle
 * schema, reading a SELECT list, recording which row keys a mapper reads, and a recording
 * SqlRunner. Test-only: imported by *.test.ts, never by app code.
 */
import { getTableColumns, type Table } from 'drizzle-orm';
import type { SqlRunner } from './searchProducts';

/** A table's database column names, per the drizzle schema. */
export const dbCols = (t: Table): Set<string> => new Set(Object.values(getTableColumns(t)).map((c) => c.name));

/** Every `<alias>.<column>` a statement references. */
export const aliasCols = (text: string, alias: string): Set<string> =>
  new Set([...text.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, 'g'))].map((m) => m[1]));

/** The members of `cols` that `from` lacks. */
export const notIn = (cols: Iterable<string>, from: Set<string>): string[] => [...cols].filter((c) => !from.has(c));

/** A statement's output column names: the alias after AS, else the bare column. */
export function selectNames(text: string): Set<string> {
  const list = text.slice(text.indexOf('SELECT') + 'SELECT'.length, text.search(/\bFROM\b/));
  return new Set(
    list.split(',').map((item) => {
      const s = item.trim();
      const as = /\sAS\s+(\w+)$/.exec(s);
      return as ? as[1] : s.replace(/^.*\./, '');
    }),
  );
}

/** A raw row that records which keys the mapper reads, to check the SELECT list against them. */
export function recordingRow(row: Record<string, unknown>): { row: Record<string, unknown>; read: Set<string> } {
  const read = new Set<string>();
  const proxy = new Proxy(row, {
    get: (target, key) => {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key);
    },
  });
  return { row: proxy, read };
}

export interface RecordedCall {
  text: string;
  values: unknown[];
}

/** A SqlRunner that answers each statement from `answer` and records every call, in order. */
export function recordingRunner(answer: (text: string, values: unknown[]) => unknown[]): { run: SqlRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: SqlRunner = async (text, values) => {
    calls.push({ text, values });
    return answer(text, values);
  };
  return { run, calls };
}
