// lib/notifications/abuseDigest/loadAbuseDigestData.test.ts
/**
 * The digest loader against a stand-in db that never connects: every `db.select(...).from(...)` chain is built by
 * drizzle's own QueryBuilder, so each statement renders to its real SQL text and params when it is awaited, and
 * the stand-in answers by table. What this covers is the slow product searches read (spec 2026-10-23 §5b); the
 * other sections' reads answer with no rows here (their merge is covered in assembleStats.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PgTable } from 'drizzle-orm/pg-core';

interface Statement {
  table: unknown;
  sql: string;
  params: unknown[];
}

const fake = vi.hoisted(() => ({
  statements: [] as Statement[],
  /** The rows a statement resolves to, by its table and SQL text. */
  answer: (() => []) as (table: unknown, sql: string) => unknown[],
}));

vi.mock('@/db/client', async () => {
  const { QueryBuilder } = await import('drizzle-orm/pg-core');
  const qb = new QueryBuilder();
  return {
    db: {
      select: (fields: unknown) => ({
        from: (table: PgTable) => {
          const query = qb.select(fields as never).from(table as never);
          // A QueryBuilder query has no session (awaiting one throws), so this one renders itself when awaited, after
          // its where / groupBy / orderBy / limit calls (each returns the same query), and resolves to the answer.
          Object.defineProperty(query, 'then', {
            value: (onFulfilled?: (rows: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => {
                  const { sql, params } = query.toSQL();
                  fake.statements.push({ table, sql, params });
                  return fake.answer(table, sql);
                })
                .then(onFulfilled, onRejected),
          });
          return query;
        },
      }),
    },
  };
});

import { slowQueries, users } from '@/db/schema';
import { loadAbuseDigestData } from './loadAbuseDigestData';

const DAY = '2026-10-22';
const TOP = [
  { queryString: 'broad=Home&sort=keywords', occurrences: 3, accounts: 2, viaTool: 1 },
  { queryString: 'age=60', occurrences: 1, accounts: 1, viaTool: 0 },
];

/** Answers the total-users count and the two slow_queries reads; every other read gets no rows. */
function answerWith(slow: { counts: unknown[]; top: unknown[] }) {
  fake.answer = (table, sql) => {
    if (table === users && sql.startsWith('select count(*)')) return [{ totalUsers: 3 }];
    if (table === slowQueries) return sql.includes(' group by ') ? slow.top : slow.counts;
    return [];
  };
}

/** The statements that read slow_queries, in the order the loader ran them. */
const slowStatements = () => fake.statements.filter((s) => s.table === slowQueries);

/**
 * `<column> >= [day 00:00 ET] and <column> < [day+1 00:00 ET]`: the half-open ET-day window every timestamp read of
 * the loader uses (etWindowBounds), with the two days as params $start and $end.
 */
const etDayWindow = (column: string) =>
  new RegExp(
    `${column.replace(/[."]/g, '\\$&')} >= \\(\\(\\$(\\d+)\\)::date\\)::timestamp AT TIME ZONE 'America/New_York' and ` +
      `${column.replace(/[."]/g, '\\$&')} < \\(\\(\\(\\$(\\d+)\\)::date \\+ 1\\)\\)::timestamp AT TIME ZONE 'America/New_York'`,
  );

describe('loadAbuseDigestData — slow product searches (spec 2026-10-23 §5b)', () => {
  beforeEach(() => {
    fake.statements.length = 0;
    answerWith({ counts: [{ timeouts: 2, slow: 5, viaToolTotal: 1 }], top: TOP });
  });

  it("returns the day's timeouts, slow runs and tool rows, and the top query strings with their occurrences, accounts and tool occurrences", async () => {
    const stats = await loadAbuseDigestData(DAY);
    expect(stats.slowSearches).toEqual({ timeouts: 2, slow: 5, viaToolTotal: 1, top: TOP });
    // The rest of the digest still loads around it.
    expect(stats).toMatchObject({ day: DAY, totalUsers: 3, signups: [], activeUsers: [] });
  });

  it("counts timeouts and slow runs apart, and the tool's rows among them, in one statement, with no grouping, order or limit", async () => {
    await loadAbuseDigestData(DAY);
    const statements = slowStatements();
    expect(statements).toHaveLength(2);
    const [counts] = statements;
    // drizzle leaves a single-table select list unqualified ("timed_out"); the where clause is qualified.
    expect(counts.sql).toMatch(
      /^select \(count\(\*\) filter \(where "timed_out"\)\)::int, \(count\(\*\) filter \(where not "timed_out"\)\)::int, \(count\(\*\) filter \(where "surface" = \$1\)\)::int from "slow_queries" where /,
    );
    // viaToolTotal: the rows of the search_products tool's surface.
    expect(counts.params[0]).toBe('products_tool');
    expect(counts.sql).not.toMatch(/ group by | order by | limit /);
  });

  it('reads the top ten query strings by occurrences (ties by the string), with count(distinct user_id) as the accounts and the products_tool rows counted apart', async () => {
    await loadAbuseDigestData(DAY);
    const [, top] = slowStatements();
    expect(top.sql).toMatch(
      /^select "query_string", count\(\*\)::int, count\(distinct "user_id"\)::int, \(count\(\*\) filter \(where "surface" = \$1\)\)::int from "slow_queries" where .+ group by "slow_queries"\."query_string" order by count\(\*\) desc, "slow_queries"\."query_string" asc limit \$\d+$/,
    );
    // viaTool: the occurrences of the search_products tool's surface.
    expect(top.params[0]).toBe('products_tool');
    expect(top.params.at(-1)).toBe(10);
  });

  it('scopes both reads to the two product-search surfaces (the list and the tool) and to [day 00:00 ET, day + 1 00:00 ET), the bounds the other timestamp reads use', async () => {
    await loadAbuseDigestData(DAY);
    expect(slowStatements()).toHaveLength(2);
    for (const s of slowStatements()) {
      // The timeouts and slow counts, and the top list, cover both surfaces.
      const surfaces = s.sql.match(/ where \("slow_queries"\."surface" in \(\$(\d+), \$(\d+)\) and /);
      expect(surfaces).not.toBeNull();
      expect([s.params[Number(surfaces![1]) - 1], s.params[Number(surfaces![2]) - 1]]).toEqual(['products', 'products_tool']);
      const window = s.sql.match(etDayWindow('"slow_queries"."happened_at"'));
      expect(window).not.toBeNull();
      expect([s.params[Number(window![1]) - 1], s.params[Number(window![2]) - 1]]).toEqual([DAY, DAY]);
    }
    // The same ET-day bounds as the signups read (users.created_at) of the same digest.
    const signups = fake.statements.find((s) => s.table === users && s.sql.includes('"users"."created_at" >='));
    expect(signups?.sql).toMatch(etDayWindow('"users"."created_at"'));
  });

  it('a day without slow searches: zero counts and no rows', async () => {
    answerWith({ counts: [{ timeouts: 0, slow: 0, viaToolTotal: 0 }], top: [] });
    expect((await loadAbuseDigestData(DAY)).slowSearches).toStrictEqual({ timeouts: 0, slow: 0, viaToolTotal: 0, top: [] });
  });

  it('a counts read with no row reads as zero counts', async () => {
    answerWith({ counts: [], top: [] });
    expect((await loadAbuseDigestData(DAY)).slowSearches).toStrictEqual({ timeouts: 0, slow: 0, viaToolTotal: 0, top: [] });
  });
});
