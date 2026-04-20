# Plan 2 — Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest 1.5GB weekly Amazon SFR CSV files from admin uploads into Neon, with full validation, batch health reporting, and replace-week support. End state: admin can bulk-upload 36+ real CSVs, review validation, and import them — data lands in `keyword_weekly_metrics`.

**Architecture:** Multi-file bulk upload via presigned R2 URLs (no ZIP). Inngest pipelines: a per-file validation pipeline, a per-file streaming import pipeline, and a batch orchestrator. CSV parsing uses `csv-parse` streaming mode to keep memory constant. Schema uses Postgres native partitioning on `keyword_weekly_metrics` with year-bucket partitions.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM, Neon Postgres (partitioned tables + `pg_trgm`), Clerk, Cloudflare R2 (presigned URLs), Inngest, `csv-parse` (streaming), Vitest.

**Prerequisites:**
- Plan 1 is complete and merged to `main` (foundation scaffold — auth, R2, Inngest, Drizzle all wired)
- Current branch: `feat/plan-2-ingestion` (already created from `main`)
- `.env.local` is populated with Neon, Clerk, R2, and Inngest credentials
- Node 20+ and pnpm installed

**Conventions:**
- TDD throughout: failing test → minimal implementation → passing test → commit
- Commit style: `feat:`, `fix:`, `chore:`, `test:`, `docs:` conventional prefixes
- Every task ends with `pnpm typecheck && pnpm test` passing
- Every task commits to `feat/plan-2-ingestion`, pushes to origin

---

## Task 1: Add migration 0002 — extension, enum, search_terms, reporting_weeks, uploaded_files.replaced_at

**Files:**
- Create: `db/schema/searchTerms.ts`, `db/schema/reportingWeeks.ts`
- Modify: `db/schema/uploads.ts`, `db/schema/index.ts`
- Generate: `db/migrations/0002_*.sql` and meta files

- [ ] **Step 1: Create `db/schema/searchTerms.ts`**

```ts
import { pgTable, uuid, varchar, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const searchTerms = pgTable(
  'search_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchTermRaw: varchar('search_term_raw', { length: 512 }).notNull(),
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }).notNull(),
    firstSeenWeek: date('first_seen_week').notNull(),
    lastSeenWeek: date('last_seen_week').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    normalizedIdx: uniqueIndex('search_terms_normalized_idx').on(t.searchTermNormalized),
    // GIN trigram index added manually via SQL in migration (drizzle-kit doesn't emit GIN trgm)
  }),
);

export type SearchTerm = typeof searchTerms.$inferSelect;
export type NewSearchTerm = typeof searchTerms.$inferInsert;
```

- [ ] **Step 2: Create `db/schema/reportingWeeks.ts`**

```ts
import { pgTable, uuid, date, boolean, timestamp } from 'drizzle-orm/pg-core';
import { uploadedFiles } from './uploads';

export const reportingWeeks = pgTable('reporting_weeks', {
  weekEndDate: date('week_end_date').primaryKey(),
  weekStartDate: date('week_start_date').notNull(),
  sourceFileId: uuid('source_file_id').references(() => uploadedFiles.id),
  isComplete: boolean('is_complete').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ReportingWeek = typeof reportingWeeks.$inferSelect;
export type NewReportingWeek = typeof reportingWeeks.$inferInsert;
```

- [ ] **Step 3: Add `replacedAt` column to `db/schema/uploads.ts`**

Find the `uploadedFiles` table definition and add this column right after `importedAt`:

```ts
  importedAt: timestamp('imported_at', { withTimezone: true }),
  replacedAt: timestamp('replaced_at', { withTimezone: true }),
```

Also add a new enum value if not already present. Confirm `fake_volume_eval_status` enum does not already exist — it should not.

Add this at the top of `db/schema/uploads.ts` near the other enum declarations (after `ingestionSeverityEnum`):

```ts
export const fakeVolumeEvalStatusEnum = pgEnum('fake_volume_eval_status', [
  'evaluated',
  'unknown_missing_conversion',
  'unknown_missing_click',
]);
```

- [ ] **Step 4: Update `db/schema/index.ts`**

Add these two exports at the end:

```ts
export * from './searchTerms';
export * from './reportingWeeks';
```

- [ ] **Step 5: Generate migration**

```bash
cd "C:/Users/raw50/Amazon Keyword Analytics"
pnpm db:generate
```

Expected: new file `db/migrations/0002_<name>.sql` created. Examine the generated SQL — it should contain:
- `CREATE TYPE fake_volume_eval_status AS ENUM(...)`
- `CREATE TABLE search_terms ...`
- `CREATE TABLE reporting_weeks ...`
- `CREATE UNIQUE INDEX search_terms_normalized_idx ...`
- `ALTER TABLE uploaded_files ADD COLUMN replaced_at ...`

- [ ] **Step 6: Add pg_trgm extension + GIN index manually**

Drizzle-kit does not emit GIN trigram indexes. Open the generated SQL file and add these lines at the top:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

And add at the bottom (after the `CREATE TABLE search_terms`):

```sql
CREATE INDEX search_terms_normalized_trgm_idx ON search_terms USING gin (search_term_normalized gin_trgm_ops);
```

- [ ] **Step 7: Apply migration**

```bash
pnpm db:migrate
```

Expected: migration applied successfully.

- [ ] **Step 8: Verify in Neon**

```bash
cd "C:/Users/raw50/Amazon Keyword Analytics" && node --env-file=.env.local --experimental-strip-types -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const tables = await sql\`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name\`;
console.log('Tables:', tables.map(t => t.table_name).join(', '));
const cols = await sql\`SELECT column_name FROM information_schema.columns WHERE table_name='uploaded_files' AND column_name='replaced_at'\`;
console.log('replaced_at column:', cols.length ? 'EXISTS' : 'MISSING');
const ext = await sql\`SELECT extname FROM pg_extension WHERE extname='pg_trgm'\`;
console.log('pg_trgm extension:', ext.length ? 'ENABLED' : 'MISSING');
"
```

Expected output contains: `search_terms`, `reporting_weeks`, `replaced_at column: EXISTS`, `pg_trgm extension: ENABLED`.

- [ ] **Step 9: Verify typecheck + test**

```bash
pnpm typecheck
pnpm test
```

Both pass.

- [ ] **Step 10: Commit**

```bash
git add db/schema/ db/migrations/
git commit -m "feat(db): add search_terms, reporting_weeks, pg_trgm extension"
git push
```

---

## Task 2: Add migration 0003 — keyword_weekly_metrics partitioned table

**Files:**
- Create: `db/schema/keywordWeeklyMetrics.ts`
- Modify: `db/schema/index.ts`
- Generate: `db/migrations/0003_*.sql` (will be manually extended)

- [ ] **Step 1: Create `db/schema/keywordWeeklyMetrics.ts`**

```ts
import {
  pgTable,
  uuid,
  integer,
  date,
  varchar,
  text,
  numeric,
  boolean,
  smallint,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { searchTerms } from './searchTerms';
import { uploadedFiles, fakeVolumeEvalStatusEnum } from './uploads';

export const keywordWeeklyMetrics = pgTable(
  'keyword_weekly_metrics',
  {
    weekEndDate: date('week_end_date').notNull(),
    searchTermId: uuid('search_term_id').notNull().references(() => searchTerms.id),
    actualRank: integer('actual_rank').notNull(),
    topClickedBrand1: varchar('top_clicked_brand_1', { length: 255 }),
    topClickedBrand2: varchar('top_clicked_brand_2', { length: 255 }),
    topClickedBrand3: varchar('top_clicked_brand_3', { length: 255 }),
    topClickedCategory1: varchar('top_clicked_category_1', { length: 255 }),
    topClickedCategory2: varchar('top_clicked_category_2', { length: 255 }),
    topClickedCategory3: varchar('top_clicked_category_3', { length: 255 }),
    topClickedProduct1Asin: varchar('top_clicked_product_1_asin', { length: 20 }),
    topClickedProduct2Asin: varchar('top_clicked_product_2_asin', { length: 20 }),
    topClickedProduct3Asin: varchar('top_clicked_product_3_asin', { length: 20 }),
    topClickedProduct1Title: text('top_clicked_product_1_title'),
    topClickedProduct2Title: text('top_clicked_product_2_title'),
    topClickedProduct3Title: text('top_clicked_product_3_title'),
    topClickedProduct1ClickShare: numeric('top_clicked_product_1_click_share', { precision: 5, scale: 2 }),
    topClickedProduct2ClickShare: numeric('top_clicked_product_2_click_share', { precision: 5, scale: 2 }),
    topClickedProduct3ClickShare: numeric('top_clicked_product_3_click_share', { precision: 5, scale: 2 }),
    topClickedProduct1ConversionShare: numeric('top_clicked_product_1_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct2ConversionShare: numeric('top_clicked_product_2_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct3ConversionShare: numeric('top_clicked_product_3_conversion_share', { precision: 5, scale: 2 }),
    keywordInTitle1: boolean('keyword_in_title_1'),
    keywordInTitle2: boolean('keyword_in_title_2'),
    keywordInTitle3: boolean('keyword_in_title_3'),
    keywordTitleMatchCount: smallint('keyword_title_match_count'),
    fakeVolumeFlag: boolean('fake_volume_flag'),
    fakeVolumeEvalStatus: fakeVolumeEvalStatusEnum('fake_volume_eval_status'),
    fakeVolumeRuleVersionId: uuid('fake_volume_rule_version_id'),
    sourceFileId: uuid('source_file_id').notNull().references(() => uploadedFiles.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekEndDate, t.searchTermId] }),
    rankIdx: index('kwm_week_rank_idx').on(t.weekEndDate, t.actualRank),
    termWeekIdx: index('kwm_term_week_idx').on(t.searchTermId, t.weekEndDate),
    categoryIdx: index('kwm_week_category_idx').on(t.weekEndDate, t.topClickedCategory1),
  }),
);

export type KeywordWeeklyMetric = typeof keywordWeeklyMetrics.$inferSelect;
export type NewKeywordWeeklyMetric = typeof keywordWeeklyMetrics.$inferInsert;
```

- [ ] **Step 2: Update `db/schema/index.ts`**

Add:

```ts
export * from './keywordWeeklyMetrics';
```

- [ ] **Step 3: Generate migration (base SQL)**

```bash
pnpm db:generate
```

This creates `db/migrations/0003_<name>.sql` with a non-partitioned `CREATE TABLE`. We'll manually convert it to partitioned.

- [ ] **Step 4: Manually rewrite migration 0003 as partitioned**

Open the generated `db/migrations/0003_<name>.sql`. Replace the body with:

```sql
CREATE TABLE "keyword_weekly_metrics" (
  "week_end_date" date NOT NULL,
  "search_term_id" uuid NOT NULL,
  "actual_rank" integer NOT NULL,
  "top_clicked_brand_1" varchar(255),
  "top_clicked_brand_2" varchar(255),
  "top_clicked_brand_3" varchar(255),
  "top_clicked_category_1" varchar(255),
  "top_clicked_category_2" varchar(255),
  "top_clicked_category_3" varchar(255),
  "top_clicked_product_1_asin" varchar(20),
  "top_clicked_product_2_asin" varchar(20),
  "top_clicked_product_3_asin" varchar(20),
  "top_clicked_product_1_title" text,
  "top_clicked_product_2_title" text,
  "top_clicked_product_3_title" text,
  "top_clicked_product_1_click_share" numeric(5,2),
  "top_clicked_product_2_click_share" numeric(5,2),
  "top_clicked_product_3_click_share" numeric(5,2),
  "top_clicked_product_1_conversion_share" numeric(5,2),
  "top_clicked_product_2_conversion_share" numeric(5,2),
  "top_clicked_product_3_conversion_share" numeric(5,2),
  "keyword_in_title_1" boolean,
  "keyword_in_title_2" boolean,
  "keyword_in_title_3" boolean,
  "keyword_title_match_count" smallint,
  "fake_volume_flag" boolean,
  "fake_volume_eval_status" fake_volume_eval_status,
  "fake_volume_rule_version_id" uuid,
  "source_file_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("week_end_date", "search_term_id"),
  FOREIGN KEY ("search_term_id") REFERENCES "search_terms"("id"),
  FOREIGN KEY ("source_file_id") REFERENCES "uploaded_files"("id")
) PARTITION BY RANGE ("week_end_date");

CREATE TABLE "keyword_weekly_metrics_2024" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE "keyword_weekly_metrics_2025" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE "keyword_weekly_metrics_2026" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE "keyword_weekly_metrics_2027" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE INDEX "kwm_week_rank_idx" ON "keyword_weekly_metrics" ("week_end_date", "actual_rank");
CREATE INDEX "kwm_term_week_idx" ON "keyword_weekly_metrics" ("search_term_id", "week_end_date");
CREATE INDEX "kwm_week_category_idx" ON "keyword_weekly_metrics" ("week_end_date", "top_clicked_category_1");
```

Delete any non-partitioned `CREATE TABLE "keyword_weekly_metrics"` that drizzle-kit generated above.

- [ ] **Step 5: Apply migration**

```bash
pnpm db:migrate
```

Expected: success.

- [ ] **Step 6: Verify partitioning**

```bash
cd "C:/Users/raw50/Amazon Keyword Analytics" && node --env-file=.env.local --experimental-strip-types -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const parts = await sql\`SELECT inhrelid::regclass AS partition FROM pg_inherits WHERE inhparent = 'keyword_weekly_metrics'::regclass\`;
console.log('Partitions:', parts.map(p => p.partition).join(', '));
"
```

Expected: `keyword_weekly_metrics_2024, keyword_weekly_metrics_2025, keyword_weekly_metrics_2026, keyword_weekly_metrics_2027`.

- [ ] **Step 7: Run tests + typecheck**

```bash
pnpm typecheck
pnpm test
```

Both pass.

- [ ] **Step 8: Commit**

```bash
git add db/schema/keywordWeeklyMetrics.ts db/schema/index.ts db/migrations/
git commit -m "feat(db): add partitioned keyword_weekly_metrics with year partitions"
git push
```

---

## Task 3: Add migration 0004 — staging_weekly_metrics

**Files:**
- Create: `db/schema/stagingWeeklyMetrics.ts`
- Modify: `db/schema/index.ts`
- Generate: `db/migrations/0004_*.sql`

- [ ] **Step 1: Create `db/schema/stagingWeeklyMetrics.ts`**

```ts
import {
  pgTable,
  uuid,
  integer,
  date,
  varchar,
  text,
  numeric,
  boolean,
  smallint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { uploadBatches, uploadedFiles, fakeVolumeEvalStatusEnum } from './uploads';
import { searchTerms } from './searchTerms';

export const stagingWeeklyMetrics = pgTable(
  'staging_weekly_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => uploadBatches.id),
    uploadedFileId: uuid('uploaded_file_id')
      .notNull()
      .references(() => uploadedFiles.id),
    weekEndDate: date('week_end_date').notNull(),
    searchTermRaw: varchar('search_term_raw', { length: 512 }).notNull(),
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }).notNull(),
    searchTermId: uuid('search_term_id').references(() => searchTerms.id),
    actualRank: integer('actual_rank').notNull(),
    topClickedBrand1: varchar('top_clicked_brand_1', { length: 255 }),
    topClickedBrand2: varchar('top_clicked_brand_2', { length: 255 }),
    topClickedBrand3: varchar('top_clicked_brand_3', { length: 255 }),
    topClickedCategory1: varchar('top_clicked_category_1', { length: 255 }),
    topClickedCategory2: varchar('top_clicked_category_2', { length: 255 }),
    topClickedCategory3: varchar('top_clicked_category_3', { length: 255 }),
    topClickedProduct1Asin: varchar('top_clicked_product_1_asin', { length: 20 }),
    topClickedProduct2Asin: varchar('top_clicked_product_2_asin', { length: 20 }),
    topClickedProduct3Asin: varchar('top_clicked_product_3_asin', { length: 20 }),
    topClickedProduct1Title: text('top_clicked_product_1_title'),
    topClickedProduct2Title: text('top_clicked_product_2_title'),
    topClickedProduct3Title: text('top_clicked_product_3_title'),
    topClickedProduct1ClickShare: numeric('top_clicked_product_1_click_share', { precision: 5, scale: 2 }),
    topClickedProduct2ClickShare: numeric('top_clicked_product_2_click_share', { precision: 5, scale: 2 }),
    topClickedProduct3ClickShare: numeric('top_clicked_product_3_click_share', { precision: 5, scale: 2 }),
    topClickedProduct1ConversionShare: numeric('top_clicked_product_1_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct2ConversionShare: numeric('top_clicked_product_2_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct3ConversionShare: numeric('top_clicked_product_3_conversion_share', { precision: 5, scale: 2 }),
    keywordInTitle1: boolean('keyword_in_title_1'),
    keywordInTitle2: boolean('keyword_in_title_2'),
    keywordInTitle3: boolean('keyword_in_title_3'),
    keywordTitleMatchCount: smallint('keyword_title_match_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileIdx: index('staging_file_idx').on(t.uploadedFileId),
    normalizedIdx: index('staging_normalized_idx').on(t.searchTermNormalized),
  }),
);

export type StagingWeeklyMetric = typeof stagingWeeklyMetrics.$inferSelect;
export type NewStagingWeeklyMetric = typeof stagingWeeklyMetrics.$inferInsert;
```

- [ ] **Step 2: Update `db/schema/index.ts`**

Add:

```ts
export * from './stagingWeeklyMetrics';
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

- [ ] **Step 4: Apply migration**

```bash
pnpm db:migrate
```

- [ ] **Step 5: Verify**

```bash
cd "C:/Users/raw50/Amazon Keyword Analytics" && node --env-file=.env.local --experimental-strip-types -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const cols = await sql\`SELECT COUNT(*) as c FROM information_schema.columns WHERE table_name='staging_weekly_metrics'\`;
console.log('staging_weekly_metrics columns:', cols[0].c);
"
```

Expected: ~32 columns.

- [ ] **Step 6: Typecheck + test + commit**

```bash
pnpm typecheck
pnpm test
git add db/schema/stagingWeeklyMetrics.ts db/schema/index.ts db/migrations/
git commit -m "feat(db): add staging_weekly_metrics table"
git push
```

---

## Task 4: Build presigned R2 URL helper

**Files:**
- Modify: `lib/storage/r2.ts` (add batch presign function)
- Create: `lib/storage/r2.test.ts`

- [ ] **Step 1: Write failing test**

Create `lib/storage/r2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildUploadStorageKey } from './r2';

describe('buildUploadStorageKey', () => {
  it('generates a key under uploads/<batchId>/<fileId>/<safe_filename>', () => {
    const key = buildUploadStorageKey({
      batchId: 'b-123',
      fileId: 'f-456',
      filename: 'US_Top_Search_Terms_Simple_Week_2026_04_18.csv',
    });
    expect(key).toBe(
      'uploads/b-123/f-456/US_Top_Search_Terms_Simple_Week_2026_04_18.csv',
    );
  });

  it('sanitizes dangerous filename characters', () => {
    const key = buildUploadStorageKey({
      batchId: 'b-1',
      fileId: 'f-1',
      filename: '../../../etc/passwd.csv',
    });
    expect(key).not.toContain('..');
    expect(key).toMatch(/^uploads\/b-1\/f-1\/[a-zA-Z0-9._-]+$/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test lib/storage/r2
```

Expected: fail with `buildUploadStorageKey is not a function`.

- [ ] **Step 3: Implement `buildUploadStorageKey`**

Add to `lib/storage/r2.ts` (at the end of the file):

```ts
export interface UploadKeyInput {
  batchId: string;
  fileId: string;
  filename: string;
}

export function buildUploadStorageKey(input: UploadKeyInput): string {
  // Strip any path components (prevent directory traversal)
  const base = input.filename.split(/[\\/]/).pop() ?? 'upload.csv';
  // Keep only safe characters
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `uploads/${input.batchId}/${input.fileId}/${safe}`;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test lib/storage/r2
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/storage/
git commit -m "feat(storage): add buildUploadStorageKey helper"
git push
```

---

## Task 5: Build streaming CSV parser

**Files:**
- Create: `lib/csv/streamParse.ts`, `lib/csv/streamParse.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/csv/streamParse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { streamParseCsv } from './streamParse';

function streamFromBuffer(buf: Buffer): Readable {
  return Readable.from(buf);
}

describe('streamParseCsv', () => {
  it('parses the real sample fixture and yields rows with header keys', async () => {
    const buf = readFileSync(path.join(__dirname, 'fixtures/valid-sample.csv'));
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(buf))) {
      rows.push(row);
    }
    expect(rows.length).toBeGreaterThan(90);
    const first = rows[0];
    expect(first['Search Frequency Rank']).toBeTruthy();
    expect(first['Search Term']).toBeTruthy();
    expect(first['Reporting Date']).toMatch(/\d+\/\d+\/\d+/);
  });

  it('strips UTF-8 BOM', async () => {
    const csv = '\uFEFFheader\nvalue\n';
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(Buffer.from(csv)), { skipMetadataRow: false })) {
      rows.push(row);
    }
    expect(rows[0].header).toBe('value');
  });

  it('skips the first metadata row when skipMetadataRow is true (default)', async () => {
    const csv = 'metadata,cell\nHeader A,Header B\nvalA,valB\n';
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(Buffer.from(csv)))) {
      rows.push(row);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]['Header A']).toBe('valA');
    expect(rows[0]['Header B']).toBe('valB');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test lib/csv/streamParse
```

Expected: fail with module not found.

- [ ] **Step 3: Implement `lib/csv/streamParse.ts`**

```ts
import { parse, type Parser } from 'csv-parse';
import { Readable, Transform } from 'node:stream';

export interface StreamParseOptions {
  /** If true, drop the very first line before parsing headers. Default true. */
  skipMetadataRow?: boolean;
}

/**
 * Async iterable that yields CSV rows as Record<string,string>, keyed by header.
 * Strips a UTF-8 BOM if present. By default, drops the first row (metadata) so
 * the second row becomes the header row.
 */
export async function* streamParseCsv(
  input: Readable,
  opts: StreamParseOptions = {},
): AsyncGenerator<Record<string, string>> {
  const skipMetadata = opts.skipMetadataRow ?? true;

  const source: Readable = skipMetadata ? input.pipe(stripFirstLine()) : input;
  const bomStripped = source.pipe(stripBom());

  const parser: Parser = bomStripped.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    }),
  );

  for await (const row of parser) {
    yield row as Record<string, string>;
  }
}

function stripBom(): Transform {
  let stripped = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!stripped) {
        stripped = true;
        if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          cb(null, chunk.slice(3));
          return;
        }
      }
      cb(null, chunk);
    },
  });
}

function stripFirstLine(): Transform {
  let buffer = '';
  let dropped = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (dropped) {
        cb(null, chunk);
        return;
      }
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const rest = buffer.slice(nl + 1);
        buffer = '';
        dropped = true;
        cb(null, Buffer.from(rest, 'utf8'));
      } else {
        cb();
      }
    },
    flush(cb) {
      cb(null, dropped ? null : Buffer.alloc(0));
    },
  });
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test lib/csv/streamParse
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/csv/streamParse.ts lib/csv/streamParse.test.ts
git commit -m "feat(csv): add streaming CSV parser with BOM + metadata-row handling"
git push
```

---

## Task 6: Build derived field computation

**Files:**
- Create: `lib/analytics/derivedFields.ts`, `lib/analytics/derivedFields.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/analytics/derivedFields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeForMatch, keywordInTitle, computeTitleMatchCount } from './derivedFields';

describe('normalizeForMatch', () => {
  it('lowercases and trims', () => {
    expect(normalizeForMatch('  Hello World  ')).toBe('hello world');
  });

  it('replaces punctuation with spaces', () => {
    expect(normalizeForMatch('hello-world,2025!')).toBe('hello world 2025');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeForMatch('hello    world')).toBe('hello world');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeForMatch(null)).toBe('');
    expect(normalizeForMatch(undefined)).toBe('');
  });
});

describe('keywordInTitle', () => {
  it('returns true when keyword appears as contiguous phrase', () => {
    expect(keywordInTitle('magnesium glycinate', 'Pure Magnesium Glycinate 500mg')).toBe(true);
  });

  it('returns false when keyword is not in title', () => {
    expect(keywordInTitle('magnesium glycinate', 'Vitamin C Gummies')).toBe(false);
  });

  it('handles punctuation differences', () => {
    expect(keywordInTitle("nature's bounty", 'NATURES BOUNTY 120 ct')).toBe(true);
  });

  it('returns false for empty/null title', () => {
    expect(keywordInTitle('anything', null)).toBe(false);
    expect(keywordInTitle('anything', '')).toBe(false);
  });
});

describe('computeTitleMatchCount', () => {
  it('counts how many of 3 titles contain the keyword', () => {
    expect(
      computeTitleMatchCount('magnesium', [
        'Pure Magnesium',
        'Vitamin C',
        'Magnesium 500mg',
      ]),
    ).toBe(2);
  });

  it('returns 0 when no title matches', () => {
    expect(computeTitleMatchCount('xyz', ['Apple', 'Banana', 'Cherry'])).toBe(0);
  });

  it('handles nulls in title list', () => {
    expect(computeTitleMatchCount('magnesium', ['Magnesium', null, null])).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test lib/analytics/derivedFields
```

Expected: fail with module not found.

- [ ] **Step 3: Implement `lib/analytics/derivedFields.ts`**

```ts
/**
 * Normalize text for keyword-in-title matching.
 * - Lowercase
 * - Replace punctuation and non-alphanumeric chars with spaces
 * - Collapse multiple spaces
 * - Trim
 */
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns true if the normalized title contains the normalized keyword as a contiguous phrase. */
export function keywordInTitle(keyword: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const nKw = normalizeForMatch(keyword);
  const nTitle = normalizeForMatch(title);
  if (!nKw || !nTitle) return false;
  return nTitle.includes(nKw);
}

/** Counts how many of the given titles contain the keyword. */
export function computeTitleMatchCount(
  keyword: string,
  titles: (string | null | undefined)[],
): number {
  return titles.reduce((sum, t) => (keywordInTitle(keyword, t) ? sum + 1 : sum), 0);
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test lib/analytics/derivedFields
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/analytics/
git commit -m "feat(analytics): add keyword-in-title normalization and match count"
git push
```

---

## Task 7: Build hard-fail validation checks

**Files:**
- Create: `lib/csv/validation/hardFail.ts`, `lib/csv/validation/hardFail.test.ts`, `lib/csv/validation/types.ts`

- [ ] **Step 1: Create `lib/csv/validation/types.ts`**

```ts
export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  rowNumber?: number;
  columnName?: string;
}

export interface ValidationStats {
  rowCount: number;
  blankConversionShareCount: { p1: number; p2: number; p3: number };
  blankClickShareCount: { p1: number; p2: number; p3: number };
  blankShareByCategory: Record<string, number>;
  rowsWithAnyBlankShare: number;
}
```

- [ ] **Step 2: Write failing tests**

Create `lib/csv/validation/hardFail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkRowHardFail, checkFileLevelHardFail } from './hardFail';

describe('checkRowHardFail', () => {
  const validRow = {
    'Search Frequency Rank': '5',
    'Search Term': 'magnesium',
    'Top Clicked Product #1: Click Share': '12.5',
    'Top Clicked Product #1: Conversion Share': '3.4',
    'Top Clicked Product #2: Click Share': '',
    'Top Clicked Product #2: Conversion Share': '',
    'Top Clicked Product #3: Click Share': '',
    'Top Clicked Product #3: Conversion Share': '',
    'Reporting Date': '4/11/2026',
  };

  it('returns no issues for a valid row', () => {
    expect(checkRowHardFail(validRow, 5)).toEqual([]);
  });

  it('flags invalid rank (non-numeric)', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Frequency Rank': 'abc' }, 5);
    expect(issues[0].code).toBe('INVALID_RANK');
  });

  it('flags invalid rank (zero or negative)', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Frequency Rank': '0' }, 5);
    expect(issues[0].code).toBe('INVALID_RANK');
  });

  it('flags non-numeric share when present', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': 'abc' },
      5,
    );
    expect(issues[0].code).toBe('NON_NUMERIC_SHARE');
  });

  it('flags out-of-range share (> 100)', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '150' },
      5,
    );
    expect(issues[0].code).toBe('SHARE_OUT_OF_RANGE');
  });

  it('flags out-of-range share (< 0)', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '-5' },
      5,
    );
    expect(issues[0].code).toBe('SHARE_OUT_OF_RANGE');
  });

  it('allows blank shares', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '' },
      5,
    );
    expect(issues).toEqual([]);
  });

  it('flags missing search term', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Term': '' }, 5);
    expect(issues[0].code).toBe('MISSING_SEARCH_TERM');
  });
});

describe('checkFileLevelHardFail', () => {
  it('flags mixed reporting dates', () => {
    const issues = checkFileLevelHardFail({ reportingDatesSeen: new Set(['4/11/2026', '4/18/2026']) });
    expect(issues.some((i) => i.code === 'MIXED_REPORTING_DATE')).toBe(true);
  });

  it('flags zero data rows', () => {
    const issues = checkFileLevelHardFail({ rowCount: 0 });
    expect(issues.some((i) => i.code === 'ZERO_DATA_ROWS')).toBe(true);
  });

  it('flags duplicate search term', () => {
    const issues = checkFileLevelHardFail({ duplicateSearchTerms: ['magnesium', 'tinnitus'] });
    expect(issues.some((i) => i.code === 'DUPLICATE_SEARCH_TERM')).toBe(true);
  });

  it('passes when everything is clean', () => {
    expect(
      checkFileLevelHardFail({
        rowCount: 100,
        reportingDatesSeen: new Set(['4/11/2026']),
        duplicateSearchTerms: [],
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm test lib/csv/validation/hardFail
```

- [ ] **Step 4: Implement `lib/csv/validation/hardFail.ts`**

```ts
import type { ValidationIssue } from './types';

const SHARE_COLUMNS = [
  'Top Clicked Product #1: Click Share',
  'Top Clicked Product #1: Conversion Share',
  'Top Clicked Product #2: Click Share',
  'Top Clicked Product #2: Conversion Share',
  'Top Clicked Product #3: Click Share',
  'Top Clicked Product #3: Conversion Share',
] as const;

function isBlank(v: string | undefined): boolean {
  return v === undefined || v === null || v.trim() === '';
}

export function checkRowHardFail(
  row: Record<string, string>,
  rowNumber: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Missing search term
  if (isBlank(row['Search Term'])) {
    issues.push({
      severity: 'error',
      code: 'MISSING_SEARCH_TERM',
      message: `Row ${rowNumber}: Search Term is blank`,
      rowNumber,
      columnName: 'Search Term',
    });
  }

  // Rank validity
  const rankStr = row['Search Frequency Rank'];
  const rank = Number(rankStr);
  if (isBlank(rankStr) || Number.isNaN(rank) || !Number.isFinite(rank) || rank <= 0 || !Number.isInteger(rank)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_RANK',
      message: `Row ${rowNumber}: Search Frequency Rank '${rankStr}' is not a positive integer`,
      rowNumber,
      columnName: 'Search Frequency Rank',
    });
  }

  // Share validity
  for (const col of SHARE_COLUMNS) {
    const val = row[col];
    if (isBlank(val)) continue;
    const n = Number(val);
    if (Number.isNaN(n)) {
      issues.push({
        severity: 'error',
        code: 'NON_NUMERIC_SHARE',
        message: `Row ${rowNumber}: ${col} '${val}' is not numeric`,
        rowNumber,
        columnName: col,
      });
    } else if (n < 0 || n > 100) {
      issues.push({
        severity: 'error',
        code: 'SHARE_OUT_OF_RANGE',
        message: `Row ${rowNumber}: ${col} ${n} is outside allowed 0–100 range`,
        rowNumber,
        columnName: col,
      });
    }
  }

  return issues;
}

export interface FileLevelHardFailInput {
  rowCount?: number;
  reportingDatesSeen?: Set<string>;
  duplicateSearchTerms?: string[];
}

export function checkFileLevelHardFail(input: FileLevelHardFailInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (input.rowCount !== undefined && input.rowCount === 0) {
    issues.push({
      severity: 'error',
      code: 'ZERO_DATA_ROWS',
      message: 'File has zero valid data rows',
    });
  }

  if (input.reportingDatesSeen && input.reportingDatesSeen.size > 1) {
    issues.push({
      severity: 'error',
      code: 'MIXED_REPORTING_DATE',
      message: `File has multiple reporting dates: ${Array.from(input.reportingDatesSeen).join(', ')}`,
    });
  }

  if (input.duplicateSearchTerms && input.duplicateSearchTerms.length > 0) {
    const first = input.duplicateSearchTerms.slice(0, 5).join(', ');
    const more = input.duplicateSearchTerms.length > 5 ? ` (and ${input.duplicateSearchTerms.length - 5} more)` : '';
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_SEARCH_TERM',
      message: `Duplicate search terms in file: ${first}${more}`,
    });
  }

  return issues;
}
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm test lib/csv/validation/hardFail
```

Expected: 12 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/csv/validation/
git commit -m "feat(validation): add row and file-level hard-fail checks"
git push
```

---

## Task 8: Build warning + informational checks

**Files:**
- Create: `lib/csv/validation/warnings.ts`, `lib/csv/validation/warnings.test.ts`
- Create: `lib/csv/validation/informational.ts`, `lib/csv/validation/informational.test.ts`

- [ ] **Step 1: Write warnings tests**

Create `lib/csv/validation/warnings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkRowCountAnomaly, checkBlankShareShift } from './warnings';

describe('checkRowCountAnomaly', () => {
  it('no warning when within 50–200% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 1_000_000, rollingAvg: 1_000_000 });
    expect(issues).toEqual([]);
  });

  it('warns when row count < 50% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 400_000, rollingAvg: 1_000_000 });
    expect(issues[0].code).toBe('ROW_COUNT_LOW');
  });

  it('warns when row count > 200% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 2_500_000, rollingAvg: 1_000_000 });
    expect(issues[0].code).toBe('ROW_COUNT_HIGH');
  });

  it('no warning when rolling avg is undefined (first upload)', () => {
    expect(checkRowCountAnomaly({ rowCount: 1_000_000, rollingAvg: undefined })).toEqual([]);
  });
});

describe('checkBlankShareShift', () => {
  it('warns when blank share rate jumps by more than 20 percentage points', () => {
    const issues = checkBlankShareShift({ currentRate: 0.45, rollingAvgRate: 0.2 });
    expect(issues[0].code).toBe('BLANK_SHARE_SHIFT');
  });

  it('no warning when change is within 20pp', () => {
    expect(checkBlankShareShift({ currentRate: 0.3, rollingAvgRate: 0.2 })).toEqual([]);
  });

  it('no warning when rolling avg is undefined', () => {
    expect(checkBlankShareShift({ currentRate: 0.5, rollingAvgRate: undefined })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
pnpm test lib/csv/validation/warnings
```

- [ ] **Step 3: Implement `lib/csv/validation/warnings.ts`**

```ts
import type { ValidationIssue } from './types';

export interface RowCountAnomalyInput {
  rowCount: number;
  rollingAvg: number | undefined;
}

export function checkRowCountAnomaly(input: RowCountAnomalyInput): ValidationIssue[] {
  if (input.rollingAvg === undefined || input.rollingAvg === 0) return [];
  const ratio = input.rowCount / input.rollingAvg;
  if (ratio < 0.5) {
    return [
      {
        severity: 'warning',
        code: 'ROW_COUNT_LOW',
        message: `Row count ${input.rowCount} is below 50% of recent average (${input.rollingAvg})`,
      },
    ];
  }
  if (ratio > 2.0) {
    return [
      {
        severity: 'warning',
        code: 'ROW_COUNT_HIGH',
        message: `Row count ${input.rowCount} is above 200% of recent average (${input.rollingAvg})`,
      },
    ];
  }
  return [];
}

export interface BlankShareShiftInput {
  currentRate: number;
  rollingAvgRate: number | undefined;
}

export function checkBlankShareShift(input: BlankShareShiftInput): ValidationIssue[] {
  if (input.rollingAvgRate === undefined) return [];
  const delta = Math.abs(input.currentRate - input.rollingAvgRate);
  if (delta >= 0.2) {
    return [
      {
        severity: 'warning',
        code: 'BLANK_SHARE_SHIFT',
        message: `Blank share rate ${(input.currentRate * 100).toFixed(1)}% shifted ≥20pp from recent average ${(input.rollingAvgRate * 100).toFixed(1)}%`,
      },
    ];
  }
  return [];
}
```

- [ ] **Step 4: Run warnings test, verify it passes**

```bash
pnpm test lib/csv/validation/warnings
```

- [ ] **Step 5: Write informational tests**

Create `lib/csv/validation/informational.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStatsAccumulator } from './informational';

describe('stats accumulator', () => {
  it('counts blank shares per product slot', () => {
    const acc = createStatsAccumulator();
    acc.consume({
      'Top Clicked Product #1: Click Share': '12',
      'Top Clicked Product #1: Conversion Share': '',
      'Top Clicked Product #2: Click Share': '',
      'Top Clicked Product #2: Conversion Share': '',
      'Top Clicked Product #3: Click Share': '5',
      'Top Clicked Product #3: Conversion Share': '2',
      'Top Clicked Category #1': 'Beauty',
    });
    acc.consume({
      'Top Clicked Product #1: Click Share': '',
      'Top Clicked Product #1: Conversion Share': '',
      'Top Clicked Product #2: Click Share': '',
      'Top Clicked Product #2: Conversion Share': '',
      'Top Clicked Product #3: Click Share': '',
      'Top Clicked Product #3: Conversion Share': '',
      'Top Clicked Category #1': 'Health',
    });
    const stats = acc.finalize();
    expect(stats.rowCount).toBe(2);
    expect(stats.blankClickShareCount.p1).toBe(1);
    expect(stats.blankConversionShareCount.p1).toBe(2);
    expect(stats.blankShareByCategory['Beauty']).toBe(1);
    expect(stats.blankShareByCategory['Health']).toBe(1);
    expect(stats.rowsWithAnyBlankShare).toBe(2);
  });
});
```

- [ ] **Step 6: Run test, verify failure**

```bash
pnpm test lib/csv/validation/informational
```

- [ ] **Step 7: Implement `lib/csv/validation/informational.ts`**

```ts
import type { ValidationStats } from './types';

function isBlank(v: string | undefined): boolean {
  return v === undefined || v === null || v.trim() === '';
}

export function createStatsAccumulator() {
  const stats: ValidationStats = {
    rowCount: 0,
    blankConversionShareCount: { p1: 0, p2: 0, p3: 0 },
    blankClickShareCount: { p1: 0, p2: 0, p3: 0 },
    blankShareByCategory: {},
    rowsWithAnyBlankShare: 0,
  };

  function consume(row: Record<string, string>) {
    stats.rowCount++;

    let anyBlank = false;

    for (const n of [1, 2, 3] as const) {
      const clickCol = `Top Clicked Product #${n}: Click Share`;
      const convCol = `Top Clicked Product #${n}: Conversion Share`;
      const key = `p${n}` as 'p1' | 'p2' | 'p3';
      if (isBlank(row[clickCol])) {
        stats.blankClickShareCount[key]++;
        anyBlank = true;
      }
      if (isBlank(row[convCol])) {
        stats.blankConversionShareCount[key]++;
        anyBlank = true;
      }
    }

    if (anyBlank) {
      stats.rowsWithAnyBlankShare++;
      const cat = row['Top Clicked Category #1'] ?? '(blank)';
      stats.blankShareByCategory[cat] = (stats.blankShareByCategory[cat] ?? 0) + 1;
    }
  }

  function finalize(): ValidationStats {
    return stats;
  }

  return { consume, finalize };
}
```

- [ ] **Step 8: Run informational test, verify it passes**

```bash
pnpm test lib/csv/validation
```

Expected: all validation tests pass (~17 total).

- [ ] **Step 9: Commit**

```bash
git add lib/csv/validation/
git commit -m "feat(validation): add warning checks and informational stats accumulator"
git push
```

---

## Task 9: Build validation orchestrator

**Files:**
- Create: `lib/csv/validation/orchestrate.ts`, `lib/csv/validation/orchestrate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/csv/validation/orchestrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateCsvStream } from './orchestrate';

function streamFromPath(p: string): Readable {
  return Readable.from(readFileSync(p));
}

describe('validateCsvStream (on real sample fixture)', () => {
  it('produces pass outcome for the valid sample', async () => {
    const result = await validateCsvStream({
      stream: streamFromPath(path.join(__dirname, '../fixtures/valid-sample.csv')),
      rollingAvgRowCount: undefined,
      rollingAvgBlankShareRate: undefined,
    });
    expect(result.outcome).toBe('pass');
    expect(result.stats.rowCount).toBeGreaterThan(90);
    expect(result.errors).toEqual([]);
  });

  it('detects mixed reporting dates as fail', async () => {
    const result = await validateCsvStream({
      stream: streamFromPath(path.join(__dirname, '../fixtures/mixed-dates.csv')),
      rollingAvgRowCount: undefined,
      rollingAvgBlankShareRate: undefined,
    });
    expect(result.outcome).toBe('fail');
    expect(result.errors.some((e) => e.code === 'MIXED_REPORTING_DATE')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
pnpm test lib/csv/validation/orchestrate
```

- [ ] **Step 3: Implement `lib/csv/validation/orchestrate.ts`**

```ts
import type { Readable } from 'node:stream';
import { streamParseCsv } from '../streamParse';
import { checkRowHardFail, checkFileLevelHardFail } from './hardFail';
import { checkRowCountAnomaly, checkBlankShareShift } from './warnings';
import { createStatsAccumulator } from './informational';
import type { ValidationIssue, ValidationStats } from './types';

export interface ValidateInput {
  stream: Readable;
  rollingAvgRowCount: number | undefined;
  rollingAvgBlankShareRate: number | undefined;
}

export interface ValidateResult {
  outcome: 'pass' | 'pass_with_warnings' | 'fail';
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: ValidationStats;
  reportingDate: string | undefined;
}

export async function validateCsvStream(input: ValidateInput): Promise<ValidateResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const statsAcc = createStatsAccumulator();
  const seenDates = new Set<string>();
  const seenTerms = new Set<string>();
  const duplicateTerms: string[] = [];
  let rowNumber = 0;

  for await (const row of streamParseCsv(input.stream)) {
    rowNumber++;
    const rowErrors = checkRowHardFail(row, rowNumber);
    errors.push(...rowErrors);

    const d = row['Reporting Date'];
    if (d) seenDates.add(d);

    const term = row['Search Term'];
    if (term) {
      if (seenTerms.has(term)) duplicateTerms.push(term);
      else seenTerms.add(term);
    }

    statsAcc.consume(row);
  }

  const stats = statsAcc.finalize();

  errors.push(
    ...checkFileLevelHardFail({
      rowCount: stats.rowCount,
      reportingDatesSeen: seenDates,
      duplicateSearchTerms: duplicateTerms,
    }),
  );

  warnings.push(
    ...checkRowCountAnomaly({
      rowCount: stats.rowCount,
      rollingAvg: input.rollingAvgRowCount,
    }),
  );

  const currentBlankRate = stats.rowCount > 0 ? stats.rowsWithAnyBlankShare / stats.rowCount : 0;
  warnings.push(
    ...checkBlankShareShift({
      currentRate: currentBlankRate,
      rollingAvgRate: input.rollingAvgBlankShareRate,
    }),
  );

  const outcome: ValidateResult['outcome'] =
    errors.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass';

  const reportingDate = seenDates.size === 1 ? seenDates.values().next().value : undefined;

  return { outcome, errors, warnings, stats, reportingDate };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test lib/csv/validation/orchestrate
```

- [ ] **Step 5: Commit**

```bash
git add lib/csv/validation/
git commit -m "feat(validation): add orchestrate.ts composing all checks over a stream"
git push
```

---

## Task 10: Build validation Inngest function

**Files:**
- Create: `inngest/functions/validate.ts`, `inngest/functions/validate.test.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Write failing test**

Create `inngest/functions/validate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockDownloadStream, mockUpdate, mockInsert, mockFindFile, mockFindReportingWeek } = vi.hoisted(() => ({
  mockDownloadStream: vi.fn(),
  mockUpdate: vi.fn(),
  mockInsert: vi.fn(),
  mockFindFile: vi.fn(),
  mockFindReportingWeek: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({
  downloadStreamFromR2: mockDownloadStream,
}));

vi.mock('@/db/client', () => ({
  db: {
    update: (...a: unknown[]) => mockUpdate(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      uploadedFiles: { findFirst: mockFindFile },
      reportingWeeks: { findFirst: mockFindReportingWeek },
    },
  },
}));

import { processFileValidation } from './validate';

describe('processFileValidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates a clean file and marks it pass', async () => {
    const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    mockFindFile.mockResolvedValueOnce({ id: 'f1', storageKey: 'k', batchId: 'b1' });
    mockFindReportingWeek.mockResolvedValueOnce(undefined);
    mockDownloadStream.mockResolvedValueOnce(Readable.from(buf));
    mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const result = await processFileValidation({ uploadedFileId: 'f1' });
    expect(result.outcome).toBe('pass');
  });
});
```

- [ ] **Step 2: Add `downloadStreamFromR2` helper**

Add to `lib/storage/r2.ts`:

```ts
export async function downloadStreamFromR2(key: string): Promise<import('node:stream').Readable> {
  const result = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  return result.Body as import('node:stream').Readable;
}
```

- [ ] **Step 3: Run test, verify failure**

```bash
pnpm test inngest/functions/validate
```

- [ ] **Step 4: Implement `inngest/functions/validate.ts`**

```ts
import { eq } from 'drizzle-orm';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { validateCsvStream } from '@/lib/csv/validation/orchestrate';
import { checkFileLevelHardFail } from '@/lib/csv/validation/hardFail';
import { db } from '@/db/client';
import { uploadedFiles, reportingWeeks, ingestionErrors } from '@/db/schema';

export interface ValidateFileInput {
  uploadedFileId: string;
}

export interface ValidateFileOutput {
  outcome: 'pass' | 'pass_with_warnings' | 'fail';
}

function parseReportingDateToIso(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export async function processFileValidation(input: ValidateFileInput): Promise<ValidateFileOutput> {
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, input.uploadedFileId),
  });
  if (!file) throw new Error(`uploaded file ${input.uploadedFileId} not found`);

  const stream = await downloadStreamFromR2(file.storageKey);
  const result = await validateCsvStream({
    stream,
    rollingAvgRowCount: undefined,
    rollingAvgBlankShareRate: undefined,
  });

  // Check for duplicate-week
  const weekEndDateIso = parseReportingDateToIso(result.reportingDate);
  if (weekEndDateIso && !file.isReplacement) {
    const existing = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.weekEndDate, weekEndDateIso),
    });
    if (existing) {
      result.errors.push({
        severity: 'error',
        code: 'WEEK_ALREADY_LOADED',
        message: `Week ${weekEndDateIso} already exists. Use replace flow to overwrite.`,
      });
    }
  }

  const finalOutcome =
    result.errors.length > 0 ? 'fail' : result.warnings.length > 0 ? 'pass_with_warnings' : 'pass';

  // Persist per-row errors
  if (result.errors.length > 0) {
    const rows = result.errors.slice(0, 500).map((e) => ({
      uploadedFileId: input.uploadedFileId,
      severity: e.severity,
      code: e.code,
      message: e.message,
      rowNumber: e.rowNumber ?? null,
      columnName: e.columnName ?? null,
    }));
    if (rows.length > 0) {
      await db.insert(ingestionErrors).values(rows);
    }
  }

  // Persist summary on uploaded_files
  await db
    .update(uploadedFiles)
    .set({
      validationStatus: finalOutcome,
      validationErrorsJson: { errors: result.errors.slice(0, 500), total: result.errors.length },
      validationWarningsJson: { warnings: result.warnings },
      validationInfoJson: { stats: result.stats },
      rowCountRaw: result.stats.rowCount,
      weekEndDate: weekEndDateIso ?? undefined,
      reportingDateRaw: result.reportingDate ?? null,
    })
    .where(eq(uploadedFiles.id, input.uploadedFileId));

  return { outcome: finalOutcome };
}

export const validateFileFn = inngest.createFunction(
  { id: 'validate-file', name: 'Validate uploaded file' },
  { event: 'csv/file.validate' },
  async ({ event, step }) => {
    return step.run('validate', () =>
      processFileValidation({
        uploadedFileId: (event.data as { uploadedFileId: string }).uploadedFileId,
      }),
    );
  },
);
```

- [ ] **Step 5: Register in `inngest/functions/index.ts`**

Update to:

```ts
import { rubricUploadedFn } from './rubric';
import { validateFileFn } from './validate';

export const functions = [rubricUploadedFn, validateFileFn];
```

- [ ] **Step 6: Run test, verify it passes**

```bash
pnpm test inngest/functions
```

- [ ] **Step 7: Commit**

```bash
git add lib/storage/r2.ts inngest/functions/
git commit -m "feat(inngest): add validate-file function"
git push
```

---

## Task 11: Build per-file import Inngest function (streaming insert)

**Files:**
- Create: `inngest/functions/importFile.ts`, `inngest/functions/importFile.test.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Write the failing test**

Create `inngest/functions/importFile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockDownloadStream, mockExecute, mockDelete, mockUpdate, mockInsert, mockFindFile } = vi.hoisted(() => ({
  mockDownloadStream: vi.fn(),
  mockExecute: vi.fn().mockResolvedValue(undefined),
  mockDelete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  mockUpdate: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  mockInsert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) }),
  mockFindFile: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({ downloadStreamFromR2: mockDownloadStream }));
vi.mock('@/db/client', () => ({
  db: {
    execute: mockExecute,
    delete: mockDelete,
    update: mockUpdate,
    insert: mockInsert,
    query: {
      uploadedFiles: { findFirst: mockFindFile },
    },
    transaction: vi.fn().mockImplementation(async (fn: Function) => fn({
      execute: mockExecute,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
    })),
  },
}));

import { processFileImport } from './importFile';

describe('processFileImport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams the fixture through staging and into keyword_weekly_metrics', async () => {
    const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    mockFindFile.mockResolvedValueOnce({
      id: 'f1',
      batchId: 'b1',
      storageKey: 'k',
      weekEndDate: '2026-04-11',
      isReplacement: false,
    });
    mockDownloadStream.mockResolvedValueOnce(Readable.from(buf));

    const result = await processFileImport({ uploadedFileId: 'f1' });
    expect(result.rowsImported).toBeGreaterThan(90);
    expect(mockInsert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
pnpm test inngest/functions/importFile
```

- [ ] **Step 3: Implement `inngest/functions/importFile.ts`**

```ts
import { eq, sql } from 'drizzle-orm';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch, keywordInTitle, computeTitleMatchCount } from '@/lib/analytics/derivedFields';
import { db } from '@/db/client';
import { uploadedFiles, stagingWeeklyMetrics, searchTerms, keywordWeeklyMetrics, reportingWeeks } from '@/db/schema';

const BATCH_SIZE = 500;

export interface ImportFileInput {
  uploadedFileId: string;
}

export interface ImportFileOutput {
  rowsImported: number;
}

function parseReportingDateToIso(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function toNumeric(v: string | undefined | null): string | null {
  if (!v || v.trim() === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

function firstNonBlank(...vals: (string | undefined | null)[]): string | null {
  for (const v of vals) if (v && v.trim() !== '') return v;
  return null;
}

export async function processFileImport(input: ImportFileInput): Promise<ImportFileOutput> {
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, input.uploadedFileId),
  });
  if (!file) throw new Error(`uploaded file ${input.uploadedFileId} not found`);
  if (!file.weekEndDate) throw new Error(`file ${input.uploadedFileId} has no weekEndDate`);

  const weekEndDate = file.weekEndDate;
  const weekStartDate = new Date(Date.parse(weekEndDate));
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6);
  const weekStartIso = weekStartDate.toISOString().slice(0, 10);

  // Stage 1: stream CSV into staging_weekly_metrics
  const stream = await downloadStreamFromR2(file.storageKey);
  let rowsStaged = 0;
  let buffer: Array<typeof stagingWeeklyMetrics.$inferInsert> = [];

  for await (const row of streamParseCsv(stream)) {
    const searchTerm = row['Search Term'];
    const normalized = normalizeForMatch(searchTerm);
    const t1 = row['Top Clicked Product #1: Product Title'] ?? null;
    const t2 = row['Top Clicked Product #2: Product Title'] ?? null;
    const t3 = row['Top Clicked Product #3: Product Title'] ?? null;

    buffer.push({
      batchId: file.batchId,
      uploadedFileId: file.id,
      weekEndDate,
      searchTermRaw: searchTerm,
      searchTermNormalized: normalized,
      actualRank: Number(row['Search Frequency Rank']),
      topClickedBrand1: row['Top Clicked Brand #1'] || null,
      topClickedBrand2: row['Top Clicked Brands #2'] || null,
      topClickedBrand3: row['Top Clicked Brands #3'] || null,
      topClickedCategory1: row['Top Clicked Category #1'] || null,
      topClickedCategory2: row['Top Clicked Category #2'] || null,
      topClickedCategory3: row['Top Clicked Category #3'] || null,
      topClickedProduct1Asin: row['Top Clicked Product #1: ASIN'] || null,
      topClickedProduct2Asin: row['Top Clicked Product #2: ASIN'] || null,
      topClickedProduct3Asin: row['Top Clicked Product #3: ASIN'] || null,
      topClickedProduct1Title: t1,
      topClickedProduct2Title: t2,
      topClickedProduct3Title: t3,
      topClickedProduct1ClickShare: toNumeric(row['Top Clicked Product #1: Click Share']),
      topClickedProduct2ClickShare: toNumeric(row['Top Clicked Product #2: Click Share']),
      topClickedProduct3ClickShare: toNumeric(row['Top Clicked Product #3: Click Share']),
      topClickedProduct1ConversionShare: toNumeric(row['Top Clicked Product #1: Conversion Share']),
      topClickedProduct2ConversionShare: toNumeric(row['Top Clicked Product #2: Conversion Share']),
      topClickedProduct3ConversionShare: toNumeric(row['Top Clicked Product #3: Conversion Share']),
      keywordInTitle1: keywordInTitle(searchTerm, t1),
      keywordInTitle2: keywordInTitle(searchTerm, t2),
      keywordInTitle3: keywordInTitle(searchTerm, t3),
      keywordTitleMatchCount: computeTitleMatchCount(searchTerm, [t1, t2, t3]),
    });

    if (buffer.length >= BATCH_SIZE) {
      await db.insert(stagingWeeklyMetrics).values(buffer);
      rowsStaged += buffer.length;
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    await db.insert(stagingWeeklyMetrics).values(buffer);
    rowsStaged += buffer.length;
  }

  // Stage 2: upsert search_terms
  await db.execute(sql`
    INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
    SELECT DISTINCT ON (search_term_normalized)
      search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
    FROM staging_weekly_metrics
    WHERE uploaded_file_id = ${file.id}
    ON CONFLICT (search_term_normalized) DO UPDATE
      SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
          first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week)
  `);

  // Stage 3: link staging rows to search_term ids
  await db.execute(sql`
    UPDATE staging_weekly_metrics s
    SET search_term_id = st.id
    FROM search_terms st
    WHERE s.uploaded_file_id = ${file.id}
      AND s.search_term_normalized = st.search_term_normalized
  `);

  // Stage 4: promote to keyword_weekly_metrics
  if (file.isReplacement) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM keyword_weekly_metrics WHERE week_end_date = ${weekEndDate}::date`);
      await tx.execute(sql`
        INSERT INTO keyword_weekly_metrics (
          week_end_date, search_term_id, actual_rank,
          top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
          top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
          top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
          top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
          top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
          top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
          keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
          source_file_id
        )
        SELECT
          week_end_date, search_term_id, actual_rank,
          top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
          top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
          top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
          top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
          top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
          top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
          keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
          ${file.id}
        FROM staging_weekly_metrics
        WHERE uploaded_file_id = ${file.id}
      `);
    });
  } else {
    await db.execute(sql`
      INSERT INTO keyword_weekly_metrics (
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        source_file_id
      )
      SELECT
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        ${file.id}
      FROM staging_weekly_metrics
      WHERE uploaded_file_id = ${file.id}
      ON CONFLICT (week_end_date, search_term_id) DO NOTHING
    `);
  }

  // Stage 5: reporting_weeks + cleanup
  await db
    .insert(reportingWeeks)
    .values({
      weekEndDate,
      weekStartDate: weekStartIso,
      sourceFileId: file.id,
      isComplete: true,
    })
    .onConflictDoUpdate({
      target: reportingWeeks.weekEndDate,
      set: { sourceFileId: file.id, isComplete: true },
    });

  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
  await db
    .update(uploadedFiles)
    .set({ validationStatus: 'imported', importedAt: new Date(), rowCountLoaded: rowsStaged })
    .where(eq(uploadedFiles.id, file.id));

  return { rowsImported: rowsStaged };
}

export const importFileFn = inngest.createFunction(
  { id: 'import-file', name: 'Import file to keyword_weekly_metrics', concurrency: { limit: 1 } },
  { event: 'csv/file.import' },
  async ({ event, step }) => {
    return step.run('import', () =>
      processFileImport({
        uploadedFileId: (event.data as { uploadedFileId: string }).uploadedFileId,
      }),
    );
  },
);
```

- [ ] **Step 4: Register function**

Update `inngest/functions/index.ts`:

```ts
import { rubricUploadedFn } from './rubric';
import { validateFileFn } from './validate';
import { importFileFn } from './importFile';

export const functions = [rubricUploadedFn, validateFileFn, importFileFn];
```

- [ ] **Step 5: Run test, verify passes**

```bash
pnpm test inngest/functions
```

- [ ] **Step 6: Commit**

```bash
git add inngest/functions/
git commit -m "feat(inngest): add per-file import pipeline with streaming + staging + promote"
git push
```

---

## Task 12: Build batch import orchestrator

**Files:**
- Create: `inngest/functions/importBatch.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Create `inngest/functions/importBatch.ts`**

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { processFileImport } from './importFile';

export interface ImportBatchInput {
  batchId: string;
}

export async function processBatchImport(input: ImportBatchInput): Promise<void> {
  // Mark batch importing
  await db.update(uploadBatches).set({ status: 'importing' }).where(eq(uploadBatches.id, input.batchId));

  // Fetch passing files ordered by week
  const files = await db.query.uploadedFiles.findMany({
    where: and(
      eq(uploadedFiles.batchId, input.batchId),
      inArray(uploadedFiles.validationStatus, ['pass', 'pass_with_warnings']),
    ),
    orderBy: [asc(uploadedFiles.weekEndDate)],
  });

  let imported = 0;
  let failed = 0;

  for (const f of files) {
    try {
      await processFileImport({ uploadedFileId: f.id });
      imported++;
    } catch (e) {
      failed++;
      await db
        .update(uploadedFiles)
        .set({
          validationStatus: 'import_failed',
          validationErrorsJson: { error: e instanceof Error ? e.message : String(e) },
        })
        .where(eq(uploadedFiles.id, f.id));
    }
  }

  const finalStatus = failed === 0 ? 'imported' : imported === 0 ? 'failed' : 'imported_partial';
  await db
    .update(uploadBatches)
    .set({ status: finalStatus, completedAt: new Date() })
    .where(eq(uploadBatches.id, input.batchId));

  // Fire Plan 3 handoff
  await inngest.send({ name: 'summary/refresh-requested', data: { batchId: input.batchId } });
}

export const importBatchFn = inngest.createFunction(
  { id: 'import-batch', name: 'Import all valid files in a batch', concurrency: { limit: 1 } },
  { event: 'csv/batch.import-approved' },
  async ({ event, step }) => {
    await step.run('import-batch', () =>
      processBatchImport({ batchId: (event.data as { batchId: string }).batchId }),
    );
    return { ok: true };
  },
);
```

- [ ] **Step 2: Register function**

Update `inngest/functions/index.ts`:

```ts
import { rubricUploadedFn } from './rubric';
import { validateFileFn } from './validate';
import { importFileFn } from './importFile';
import { importBatchFn } from './importBatch';

export const functions = [rubricUploadedFn, validateFileFn, importFileFn, importBatchFn];
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm typecheck
pnpm test
```

Both pass.

- [ ] **Step 4: Commit**

```bash
git add inngest/functions/
git commit -m "feat(inngest): add batch import orchestrator"
git push
```

---

## Task 13: Build API — create batch, list batches

**Files:**
- Create: `app/api/admin/batches/route.ts`, `app/api/admin/batches/route.test.ts`

- [ ] **Step 1: Write failing test**

Create `app/api/admin/batches/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockInsert, mockFindMany } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockInsert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'new-batch-id' }]),
    }),
  }),
  mockFindMany: vi.fn().mockResolvedValue([{ id: 'b1', status: 'imported' }]),
}));

vi.mock('@/lib/auth/requireAdmin', () => ({
  requireAdmin: mockRequireAdmin,
  AuthError: class extends Error { constructor(public code: string, msg: string) { super(msg); } },
}));

vi.mock('@/db/client', () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      uploadBatches: { findMany: mockFindMany },
    },
  },
}));

import { POST, GET } from './route';

describe('POST /api/admin/batches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new batch and returns its id', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-1' });
    const req = new Request('http://localhost/api/admin/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchType: 'bulk' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.batchId).toBe('new-batch-id');
  });
});

describe('GET /api/admin/batches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns list of batches', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-1' });
    const res = await GET(new Request('http://localhost/api/admin/batches'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.batches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
pnpm test app/api/admin/batches/route.test
```

- [ ] **Step 3: Implement `app/api/admin/batches/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { batchType?: 'single_csv' | 'zip_backfill' };
  const batchType = body.batchType === 'zip_backfill' ? 'zip_backfill' : 'single_csv';

  const [batch] = await db
    .insert(uploadBatches)
    .values({
      batchType,
      status: 'uploaded',
      totalFiles: 0,
      createdByUserId: user.id,
    })
    .returning();

  return NextResponse.json({ batchId: batch.id });
}

export async function GET(_req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const batches = await db.query.uploadBatches.findMany({
    orderBy: [desc(uploadBatches.createdAt)],
    limit: 100,
  });

  return NextResponse.json({ batches });
}

export const runtime = 'nodejs';
```

- [ ] **Step 4: Run test, verify passes**

```bash
pnpm test app/api/admin/batches/route.test
```

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/batches/
git commit -m "feat(api): add POST/GET /api/admin/batches"
git push
```

---

## Task 14: Build API — presign URLs for batch files

**Files:**
- Create: `app/api/admin/batches/[id]/presign/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles, uploadBatches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildUploadStorageKey, getPresignedUploadUrl } from '@/lib/storage/r2';

interface PresignRequest {
  files: { filename: string; size: number }[];
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id: batchId } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<PresignRequest>;
  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: 'files array is required' }, { status: 400 });
  }
  if (body.files.length > 100) {
    return NextResponse.json({ error: 'max 100 files per presign request' }, { status: 400 });
  }

  // Insert one uploaded_files row per file (pending), get back ids
  const rows = await db
    .insert(uploadedFiles)
    .values(
      body.files.map((f) => ({
        batchId,
        storageKey: '',
        originalFilename: f.filename,
        validationStatus: 'pending' as const,
      })),
    )
    .returning();

  // Generate presigned URLs in parallel, set storageKey
  const presigned = await Promise.all(
    rows.map(async (row, idx) => {
      const filename = body.files![idx].filename;
      const key = buildUploadStorageKey({ batchId, fileId: row.id, filename });
      await db.update(uploadedFiles).set({ storageKey: key }).where(eq(uploadedFiles.id, row.id));
      const url = await getPresignedUploadUrl(key, 'text/csv', 3600); // 1 hr
      return { fileId: row.id, storageKey: key, url };
    }),
  );

  // Update batch total_files
  await db
    .update(uploadBatches)
    .set({ totalFiles: rows.length })
    .where(eq(uploadBatches.id, batchId));

  return NextResponse.json({ files: presigned });
}

export const runtime = 'nodejs';
```

- [ ] **Step 2: Typecheck + test**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/batches/
git commit -m "feat(api): add POST /api/admin/batches/[id]/presign"
git push
```

---

## Task 15: Build API — notify file upload complete, trigger validation

**Files:**
- Create: `app/api/admin/batches/[id]/files/[fileId]/complete/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { fileId } = await params;

  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, fileId) });
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await inngest.send({
    name: 'csv/file.validate',
    data: { uploadedFileId: fileId },
  });

  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';
```

- [ ] **Step 2: Typecheck + test + commit**

```bash
pnpm typecheck
pnpm test
git add app/api/admin/batches/
git commit -m "feat(api): add POST .../files/[fileId]/complete endpoint"
git push
```

---

## Task 16: Build APIs — batch health, import, cancel, finalize, file detail

**Files:**
- Create: `app/api/admin/batches/[id]/route.ts`
- Create: `app/api/admin/batches/[id]/import/route.ts`
- Create: `app/api/admin/batches/[id]/cancel/route.ts`
- Create: `app/api/admin/batches/[id]/finalize/route.ts`
- Create: `app/api/admin/batches/[id]/files/[fileId]/route.ts`
- Create: `app/api/admin/files/[id]/replace/route.ts`

- [ ] **Step 1: Create `app/api/admin/batches/[id]/route.ts`** (GET batch health)

```ts
import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const files = await db.query.uploadedFiles.findMany({
    where: eq(uploadedFiles.batchId, id),
    orderBy: [asc(uploadedFiles.weekEndDate), asc(uploadedFiles.createdAt)],
  });

  return NextResponse.json({ batch, files });
}

export const runtime = 'nodejs';
```

- [ ] **Step 2: Create `app/api/admin/batches/[id]/import/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await inngest.send({ name: 'csv/batch.import-approved', data: { batchId: id } });
  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';
```

- [ ] **Step 3: Create `app/api/admin/batches/[id]/cancel/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  await db.update(uploadBatches).set({ status: 'failed', completedAt: new Date() }).where(eq(uploadBatches.id, id));
  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';
```

- [ ] **Step 4: Create `app/api/admin/batches/[id]/finalize/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  const files = await db.query.uploadedFiles.findMany({ where: eq(uploadedFiles.batchId, id) });
  const passed = files.filter((f) => f.validationStatus === 'pass').length;
  const warned = files.filter((f) => f.validationStatus === 'pass_with_warnings').length;
  const failed = files.filter((f) => f.validationStatus === 'fail' || f.validationStatus === 'import_failed').length;
  const total = files.length;

  const failedPct = total === 0 ? 0 : (failed / total) * 100;
  let status: 'clean' | 'partial_review' | 'blocked' = 'clean';
  if (failed > 0) {
    status = failedPct >= 10 ? 'blocked' : 'partial_review';
  }

  await db
    .update(uploadBatches)
    .set({
      status,
      passedFiles: passed,
      warningFiles: warned,
      failedFiles: failed,
    })
    .where(eq(uploadBatches.id, id));

  return NextResponse.json({ ok: true, status });
}

export const runtime = 'nodejs';
```

- [ ] **Step 5: Create `app/api/admin/batches/[id]/files/[fileId]/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles, ingestionErrors } from '@/db/schema';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { fileId } = await params;
  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, fileId) });
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const errors = await db.query.ingestionErrors.findMany({
    where: eq(ingestionErrors.uploadedFileId, fileId),
    orderBy: [asc(ingestionErrors.rowNumber)],
    limit: 500,
  });

  return NextResponse.json({ file, errors });
}

export const runtime = 'nodejs';
```

- [ ] **Step 6: Create `app/api/admin/files/[id]/replace/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id: newFileId } = await params;
  const body = (await req.json().catch(() => ({}))) as { replacesFileId?: string };
  if (!body.replacesFileId) {
    return NextResponse.json({ error: 'replacesFileId is required' }, { status: 400 });
  }

  await db
    .update(uploadedFiles)
    .set({ isReplacement: true, replacesFileId: body.replacesFileId })
    .where(eq(uploadedFiles.id, newFileId));

  await db
    .update(uploadedFiles)
    .set({ replacedAt: new Date() })
    .where(eq(uploadedFiles.id, body.replacesFileId));

  // Re-validate the replacement file so WEEK_ALREADY_LOADED error goes away
  await inngest.send({ name: 'csv/file.validate', data: { uploadedFileId: newFileId } });

  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';
```

- [ ] **Step 7: Typecheck + test**

```bash
pnpm typecheck
pnpm test
```

Both pass.

- [ ] **Step 8: Commit**

```bash
git add app/api/admin/
git commit -m "feat(api): add batch health, import, cancel, finalize, file detail, replace endpoints"
git push
```

---

## Task 17: Build bulk uploader client component

**Files:**
- Create: `app/admin/upload/BulkUploader.tsx`

- [ ] **Step 1: Create `app/admin/upload/BulkUploader.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type FileStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';

interface FileState {
  file: File;
  fileId?: string;
  status: FileStatus;
  progress: number;
  error?: string;
}

export function BulkUploader() {
  const [files, setFiles] = useState<FileState[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onFilePick(list: FileList | null) {
    if (!list) return;
    const added: FileState[] = Array.from(list).map((f) => ({
      file: f,
      status: 'queued',
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...added]);
  }

  async function startUpload() {
    setUploading(true);
    setError(null);

    try {
      // 1. Create batch
      const batchRes = await fetch('/api/admin/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchType: 'zip_backfill' }),
      });
      if (!batchRes.ok) throw new Error('failed to create batch');
      const { batchId: newBatchId } = await batchRes.json();
      setBatchId(newBatchId);

      // 2. Request presigned URLs
      const presignRes = await fetch(`/api/admin/batches/${newBatchId}/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: files.map((f) => ({ filename: f.file.name, size: f.file.size })),
        }),
      });
      if (!presignRes.ok) throw new Error('failed to get presigned urls');
      const { files: presigned } = await presignRes.json();

      // 3. Upload files in parallel (limit 4)
      await runWithConcurrency(4, presigned, async (p: { fileId: string; url: string }, idx: number) => {
        setFiles((prev) =>
          prev.map((f, i) => (i === idx ? { ...f, fileId: p.fileId, status: 'uploading' } : f)),
        );
        try {
          await uploadOne(files[idx].file, p.url, (pct) => {
            setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, progress: pct } : f)));
          });
          await fetch(`/api/admin/batches/${newBatchId}/files/${p.fileId}/complete`, { method: 'POST' });
          setFiles((prev) =>
            prev.map((f, i) => (i === idx ? { ...f, status: 'uploaded', progress: 100 } : f)),
          );
        } catch (e) {
          setFiles((prev) =>
            prev.map((f, i) =>
              i === idx ? { ...f, status: 'failed', error: e instanceof Error ? e.message : 'failed' } : f,
            ),
          );
        }
      });

      // 4. Finalize batch
      await fetch(`/api/admin/batches/${newBatchId}/finalize`, { method: 'POST' });
      router.push(`/admin/batches/${newBatchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="block rounded border-2 border-dashed p-8 text-center">
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          onChange={(e) => onFilePick(e.target.files)}
          disabled={uploading}
          className="hidden"
        />
        <span className="cursor-pointer underline">Click to select CSV files</span>
      </label>

      {files.length > 0 && (
        <ul className="divide-y rounded border">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between p-2 text-sm">
              <span className="truncate">{f.file.name}</span>
              <span className="ml-4 font-mono">
                {f.status} {f.progress > 0 && f.progress < 100 ? `${f.progress}%` : ''}
                {f.error && <span className="text-red-600"> {f.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={startUpload}
        disabled={files.length === 0 || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : `Start upload (${files.length} files)`}
      </button>

      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

async function uploadOne(file: File, url: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'text/csv');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(file);
  });
}

async function runWithConcurrency<T>(
  limit: number,
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    });
  await Promise.all(workers);
}
```

- [ ] **Step 2: Typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Both succeed.

- [ ] **Step 3: Commit**

```bash
git add app/admin/upload/
git commit -m "feat(admin): add BulkUploader client component"
git push
```

---

## Task 18: Build bulk upload page

**Files:**
- Create: `app/admin/upload/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
import { BulkUploader } from './BulkUploader';

export default function BulkUploadPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Bulk upload</h1>
      <p className="mt-2 text-gray-600">
        Select multiple weekly SFR CSVs to upload as one batch. Files upload directly to storage — your files
        never flow through the web server. Each file is validated as it arrives.
      </p>
      <div className="mt-6">
        <BulkUploader />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm build
git add app/admin/upload/page.tsx
git commit -m "feat(admin): add bulk upload page"
git push
```

---

## Task 19: Build single-file upload page using the same uploader

**Files:**
- Create: `app/admin/upload/single/page.tsx`, `app/admin/upload/single/SingleUploader.tsx`

- [ ] **Step 1: Create `app/admin/upload/single/SingleUploader.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SingleUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const router = useRouter();

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);

    try {
      const batchRes = await fetch('/api/admin/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchType: 'single_csv' }),
      });
      const { batchId } = await batchRes.json();

      const presignRes = await fetch(`/api/admin/batches/${batchId}/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ filename: file.name, size: file.size }] }),
      });
      const { files: presigned } = await presignRes.json();
      const p = presigned[0];

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', p.url);
        xhr.setRequestHeader('Content-Type', 'text/csv');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send(file);
      });

      await fetch(`/api/admin/batches/${batchId}/files/${p.fileId}/complete`, { method: 'POST' });
      await fetch(`/api/admin/batches/${batchId}/finalize`, { method: 'POST' });

      router.push(`/admin/batches/${batchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? `Uploading… ${progress}%` : 'Upload'}
      </button>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Create `app/admin/upload/single/page.tsx`**

```tsx
import { SingleUploader } from './SingleUploader';

export default function SingleUploadPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Upload single weekly CSV</h1>
      <p className="mt-2 text-gray-600">
        Use this page for ongoing weekly uploads (one file per week).
      </p>
      <div className="mt-6">
        <SingleUploader />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
pnpm build
git add app/admin/upload/
git commit -m "feat(admin): add single-file upload page"
git push
```

---

## Task 20: Build batch health page

**Files:**
- Create: `app/admin/batches/[id]/page.tsx`, `app/admin/batches/[id]/BatchActions.tsx`

- [ ] **Step 1: Create `app/admin/batches/[id]/BatchActions.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function BatchActions({ batchId, status }: { batchId: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function call(endpoint: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  const canImport = ['clean', 'partial_review'].includes(status);
  const canCancel = !['imported', 'failed', 'importing'].includes(status);

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => call(`/api/admin/batches/${batchId}/import`)}
        disabled={!canImport || busy}
        className="rounded bg-green-600 px-4 py-2 text-white disabled:opacity-50"
      >
        Import valid files
      </button>
      <button
        onClick={() => call(`/api/admin/batches/${batchId}/cancel`)}
        disabled={!canCancel || busy}
        className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
      >
        Cancel batch
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Create `app/admin/batches/[id]/page.tsx`**

```tsx
import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles, reportingWeeks } from '@/db/schema';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { BatchActions } from './BatchActions';

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) notFound();

  const files = await db.query.uploadedFiles.findMany({
    where: eq(uploadedFiles.batchId, id),
    orderBy: [asc(uploadedFiles.weekEndDate)],
  });

  const loadedWeeks = await db.query.reportingWeeks.findMany({
    orderBy: [asc(reportingWeeks.weekEndDate)],
  });
  const loadedWeekSet = new Set(loadedWeeks.map((w) => w.weekEndDate));

  const passed = files.filter((f) => f.validationStatus === 'pass').length;
  const warned = files.filter((f) => f.validationStatus === 'pass_with_warnings').length;
  const failed = files.filter((f) => f.validationStatus === 'fail' || f.validationStatus === 'import_failed').length;
  const pending = files.filter((f) => f.validationStatus === 'pending').length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Batch {batch.id.slice(0, 8)}</h1>
        <dl className="mt-2 grid grid-cols-4 gap-4 text-sm">
          <div><dt className="text-gray-500">Status</dt><dd className="font-mono">{batch.status}</dd></div>
          <div><dt className="text-gray-500">Total files</dt><dd>{files.length}</dd></div>
          <div><dt className="text-gray-500">Passed / warned / failed</dt><dd>{passed} / {warned} / {failed}</dd></div>
          <div><dt className="text-gray-500">Pending</dt><dd>{pending}</dd></div>
        </dl>
      </header>

      <BatchActions batchId={batch.id} status={batch.status} />

      <section>
        <h2 className="text-lg font-semibold">Files</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr><th className="p-2">Filename</th><th className="p-2">Week end</th><th className="p-2">Row count</th><th className="p-2">Status</th><th className="p-2"></th></tr>
          </thead>
          <tbody className="divide-y">
            {files.map((f) => (
              <tr key={f.id}>
                <td className="p-2 truncate max-w-xs">{f.originalFilename}</td>
                <td className="p-2">{f.weekEndDate ?? '—'}</td>
                <td className="p-2">{f.rowCountRaw ?? '—'}</td>
                <td className="p-2 font-mono">{f.validationStatus}</td>
                <td className="p-2"><Link className="underline" href={`/admin/batches/${batch.id}/files/${f.id}`}>Details</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Loaded weeks (global)</h2>
        <p className="mt-1 text-sm text-gray-500">{loadedWeekSet.size} weeks currently in keyword_weekly_metrics</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
pnpm typecheck
pnpm build
git add app/admin/batches/
git commit -m "feat(admin): add batch health page with actions"
git push
```

---

## Task 21: Build file detail page

**Files:**
- Create: `app/admin/batches/[id]/files/[fileId]/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles, ingestionErrors } from '@/db/schema';
import { notFound } from 'next/navigation';

export default async function FileDetailPage({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const { id, fileId } = await params;
  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, fileId) });
  if (!file) notFound();

  const errors = await db.query.ingestionErrors.findMany({
    where: eq(ingestionErrors.uploadedFileId, fileId),
    orderBy: [asc(ingestionErrors.rowNumber)],
    limit: 500,
  });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">File {file.originalFilename}</h1>
        <dl className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div><dt className="text-gray-500">Status</dt><dd className="font-mono">{file.validationStatus}</dd></div>
          <div><dt className="text-gray-500">Week end</dt><dd>{file.weekEndDate ?? '—'}</dd></div>
          <div><dt className="text-gray-500">Rows</dt><dd>{file.rowCountRaw ?? '—'}</dd></div>
        </dl>
      </header>

      {errors.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Errors ({errors.length})</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="bg-gray-100 text-left">
              <tr><th className="p-2">Row</th><th className="p-2">Column</th><th className="p-2">Code</th><th className="p-2">Message</th></tr>
            </thead>
            <tbody className="divide-y">
              {errors.map((e) => (
                <tr key={e.id}>
                  <td className="p-2">{e.rowNumber ?? '—'}</td>
                  <td className="p-2">{e.columnName ?? '—'}</td>
                  <td className="p-2 font-mono">{e.code}</td>
                  <td className="p-2">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {file.validationWarningsJson != null && (
        <section>
          <h2 className="text-lg font-semibold">Warnings</h2>
          <pre className="mt-2 rounded bg-gray-100 p-2 text-xs overflow-auto">{JSON.stringify(file.validationWarningsJson, null, 2)}</pre>
        </section>
      )}

      {file.validationInfoJson != null && (
        <section>
          <h2 className="text-lg font-semibold">Informational stats</h2>
          <pre className="mt-2 rounded bg-gray-100 p-2 text-xs overflow-auto">{JSON.stringify(file.validationInfoJson, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build + commit**

```bash
pnpm typecheck
pnpm build
git add app/admin/batches/
git commit -m "feat(admin): add per-file detail page with errors and stats"
git push
```

---

## Task 22: Build upload history page + admin nav update

**Files:**
- Create: `app/admin/batches/page.tsx`
- Modify: `app/admin/layout.tsx`

- [ ] **Step 1: Create `app/admin/batches/page.tsx`**

```tsx
import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';
import Link from 'next/link';

export default async function BatchesHistoryPage() {
  const batches = await db.query.uploadBatches.findMany({
    orderBy: [desc(uploadBatches.createdAt)],
    limit: 100,
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold">Upload history</h1>
      <table className="mt-4 w-full text-sm">
        <thead className="bg-gray-100 text-left">
          <tr>
            <th className="p-2">Created</th>
            <th className="p-2">Type</th>
            <th className="p-2">Files</th>
            <th className="p-2">Passed / Warned / Failed</th>
            <th className="p-2">Status</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {batches.map((b) => (
            <tr key={b.id}>
              <td className="p-2">{new Date(b.createdAt).toISOString().slice(0, 16)}</td>
              <td className="p-2">{b.batchType}</td>
              <td className="p-2">{b.totalFiles}</td>
              <td className="p-2">{b.passedFiles} / {b.warningFiles} / {b.failedFiles}</td>
              <td className="p-2 font-mono">{b.status}</td>
              <td className="p-2"><Link className="underline" href={`/admin/batches/${b.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Update admin nav**

Open `app/admin/layout.tsx`. Replace the `<nav>` block with:

```tsx
<nav className="flex flex-col gap-2">
  <Link href="/admin" className="hover:underline">Overview</Link>
  <Link href="/admin/rubric" className="hover:underline">Schema rubric</Link>
  <Link href="/admin/upload" className="hover:underline">Bulk upload</Link>
  <Link href="/admin/upload/single" className="hover:underline">Single upload</Link>
  <Link href="/admin/batches" className="hover:underline">Upload history</Link>
</nav>
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
pnpm typecheck
pnpm build
git add app/admin/
git commit -m "feat(admin): add upload history page and nav links"
git push
```

---

## Task 23: Duplicate-week UI + replace action

**Files:**
- Modify: `app/admin/batches/[id]/files/[fileId]/page.tsx` (add replace button for WEEK_ALREADY_LOADED)
- Create: `app/admin/batches/[id]/files/[fileId]/ReplaceWeekButton.tsx`

- [ ] **Step 1: Create `ReplaceWeekButton.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReplaceWeekButton({ fileId, replacesFileId }: { fileId: string; replacesFileId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    if (!confirm('Replace the existing week with this file? Old data will be deleted.')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/files/${fileId}/replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replacesFileId }),
      });
      if (!res.ok) throw new Error('replace failed');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded bg-amber-600 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Replacing…' : 'Replace this week'}
      </button>
      {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Update file detail page to look up the conflicting file and show the button**

Open `app/admin/batches/[id]/files/[fileId]/page.tsx`. After fetching `file` and `errors`, add logic to find if there's a WEEK_ALREADY_LOADED error and look up the conflicting file:

```tsx
import { and, ne } from 'drizzle-orm';
import { ReplaceWeekButton } from './ReplaceWeekButton';
// ...existing imports

// After existing `errors` query, add:
const weekLoadedError = errors.find((e) => e.code === 'WEEK_ALREADY_LOADED');
let conflictingFileId: string | null = null;
if (weekLoadedError && file.weekEndDate) {
  const existing = await db.query.uploadedFiles.findFirst({
    where: and(
      eq(uploadedFiles.weekEndDate, file.weekEndDate),
      ne(uploadedFiles.id, file.id),
    ),
  });
  conflictingFileId = existing?.id ?? null;
}
```

And in the JSX, add (below the errors table):

```tsx
{weekLoadedError && conflictingFileId && (
  <div className="rounded border border-amber-300 bg-amber-50 p-4">
    <h3 className="font-semibold">Duplicate week — action needed</h3>
    <p className="mt-2 text-sm">
      Week {file.weekEndDate} is already loaded. Click below to replace the existing week with this file.
    </p>
    <div className="mt-3">
      <ReplaceWeekButton fileId={file.id} replacesFileId={conflictingFileId} />
    </div>
  </div>
)}
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
pnpm typecheck
pnpm build
git add app/admin/batches/
git commit -m "feat(admin): add replace-week action from file detail page"
git push
```

---

## Task 24: Integration test — full ingestion flow

**Files:**
- Create: `tests/integration/ingestion-flow.test.ts`

- [ ] **Step 1: Create the test**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

vi.mock('@/lib/storage/r2', async () => {
  const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  return {
    downloadStreamFromR2: vi.fn().mockResolvedValue(Readable.from(buf)),
    downloadFromR2: vi.fn().mockResolvedValue(buf),
    uploadToR2: vi.fn().mockResolvedValue('k'),
    getPresignedUploadUrl: vi.fn().mockResolvedValue('https://presigned.example/x'),
    buildUploadStorageKey: () => 'uploads/test/file.csv',
  };
});

import { db } from '@/db/client';
import { eq } from 'drizzle-orm';
import {
  users,
  uploadBatches,
  uploadedFiles,
  keywordWeeklyMetrics,
  searchTerms,
  reportingWeeks,
  stagingWeeklyMetrics,
  ingestionErrors,
} from '@/db/schema';
import { processFileValidation } from '@/inngest/functions/validate';
import { processFileImport } from '@/inngest/functions/importFile';

describe('ingestion flow (integration)', () => {
  let userId: string;
  let batchId: string;
  let fileId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: `itest_${Date.now()}`, email: `itest_${Date.now()}@x.com` })
      .returning();
    userId = user.id;

    const [batch] = await db
      .insert(uploadBatches)
      .values({ batchType: 'single_csv', status: 'uploaded', totalFiles: 1, createdByUserId: userId })
      .returning();
    batchId = batch.id;

    const [file] = await db
      .insert(uploadedFiles)
      .values({
        batchId,
        storageKey: 'test/fake.csv',
        originalFilename: 'sample.csv',
        validationStatus: 'pending',
      })
      .returning();
    fileId = file.id;
  });

  afterAll(async () => {
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, fileId));
    await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, fileId));
    await db.delete(keywordWeeklyMetrics).where(eq(keywordWeeklyMetrics.sourceFileId, fileId));
    await db.delete(reportingWeeks).where(eq(reportingWeeks.sourceFileId, fileId));
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('validates, imports, and lands rows in keyword_weekly_metrics', async () => {
    const v = await processFileValidation({ uploadedFileId: fileId });
    expect(v.outcome).toBe('pass');

    const i = await processFileImport({ uploadedFileId: fileId });
    expect(i.rowsImported).toBeGreaterThan(90);

    const rows = await db.query.keywordWeeklyMetrics.findMany({
      where: eq(keywordWeeklyMetrics.sourceFileId, fileId),
    });
    expect(rows.length).toBeGreaterThan(90);

    const week = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.sourceFileId, fileId),
    });
    expect(week?.isComplete).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
pnpm test:integration
```

Expected: both rubric-flow (from Plan 1) and ingestion-flow tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test(integration): add end-to-end ingestion flow test"
git push
```

---

## Task 25: Integration test — replace-week flow

**Files:**
- Create: `tests/integration/replace-week.test.ts`

- [ ] **Step 1: Create the test**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

vi.mock('@/lib/storage/r2', async () => {
  const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  return {
    downloadStreamFromR2: vi.fn().mockImplementation(async () => Readable.from(buf)),
    downloadFromR2: vi.fn().mockResolvedValue(buf),
    uploadToR2: vi.fn().mockResolvedValue('k'),
    getPresignedUploadUrl: vi.fn().mockResolvedValue('https://presigned.example/x'),
    buildUploadStorageKey: () => 'uploads/test/file.csv',
  };
});

import { db } from '@/db/client';
import { and, eq } from 'drizzle-orm';
import {
  users,
  uploadBatches,
  uploadedFiles,
  keywordWeeklyMetrics,
  searchTerms,
  reportingWeeks,
  stagingWeeklyMetrics,
  ingestionErrors,
} from '@/db/schema';
import { processFileValidation } from '@/inngest/functions/validate';
import { processFileImport } from '@/inngest/functions/importFile';

describe('replace-week flow (integration)', () => {
  let userId: string;
  let batchId: string;
  let firstFileId: string;
  let secondFileId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: `rw_${Date.now()}`, email: `rw_${Date.now()}@x.com` })
      .returning();
    userId = user.id;

    const [batch] = await db
      .insert(uploadBatches)
      .values({ batchType: 'single_csv', status: 'uploaded', totalFiles: 2, createdByUserId: userId })
      .returning();
    batchId = batch.id;

    const [f1] = await db
      .insert(uploadedFiles)
      .values({ batchId, storageKey: 'k1', originalFilename: 'a.csv', validationStatus: 'pending' })
      .returning();
    firstFileId = f1.id;

    const [f2] = await db
      .insert(uploadedFiles)
      .values({ batchId, storageKey: 'k2', originalFilename: 'b.csv', validationStatus: 'pending' })
      .returning();
    secondFileId = f2.id;
  });

  afterAll(async () => {
    await db.delete(ingestionErrors);
    await db.delete(stagingWeeklyMetrics);
    await db.delete(keywordWeeklyMetrics);
    await db.delete(reportingWeeks);
    await db.delete(uploadedFiles).where(eq(uploadedFiles.batchId, batchId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('rejects second upload of same week and accepts after marking replacement', async () => {
    // First file: validate + import
    await processFileValidation({ uploadedFileId: firstFileId });
    await processFileImport({ uploadedFileId: firstFileId });

    // Second file (same week): validation should fail with WEEK_ALREADY_LOADED
    const v2 = await processFileValidation({ uploadedFileId: secondFileId });
    expect(v2.outcome).toBe('fail');
    const errs = await db.query.ingestionErrors.findMany({
      where: eq(ingestionErrors.uploadedFileId, secondFileId),
    });
    expect(errs.some((e) => e.code === 'WEEK_ALREADY_LOADED')).toBe(true);

    // Mark replacement + re-validate + import
    await db
      .update(uploadedFiles)
      .set({ isReplacement: true, replacesFileId: firstFileId })
      .where(eq(uploadedFiles.id, secondFileId));
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, secondFileId));

    const v3 = await processFileValidation({ uploadedFileId: secondFileId });
    expect(v3.outcome).toBe('pass');

    const i2 = await processFileImport({ uploadedFileId: secondFileId });
    expect(i2.rowsImported).toBeGreaterThan(90);

    // reporting_weeks should now point at the second file
    const week = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.sourceFileId, secondFileId),
    });
    expect(week).toBeTruthy();

    // keyword_weekly_metrics rows should be from the second file
    const rows = await db.query.keywordWeeklyMetrics.findMany({
      where: eq(keywordWeeklyMetrics.sourceFileId, secondFileId),
    });
    expect(rows.length).toBeGreaterThan(90);
  });
});
```

- [ ] **Step 2: Run integration**

```bash
pnpm test:integration
```

Expected: 3 integration tests pass (rubric, ingestion, replace-week).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test(integration): add replace-week flow test"
git push
```

---

## Task 26: Final smoke checklist + docs update

**Files:**
- Modify: `README.md` (add Plan 2 commands)

- [ ] **Step 1: Update `README.md`**

Open `README.md`. Append this section before "## Deployment":

```markdown
## Ingestion (Plan 2)

Admin uploads weekly Amazon SFR CSVs through:

- `/admin/upload` — bulk upload (select multiple files, one batch)
- `/admin/upload/single` — single weekly file
- `/admin/batches` — upload history
- `/admin/batches/[id]` — batch health (view per-file status, import valid files)
- `/admin/batches/[id]/files/[fileId]` — per-file detail with validation errors

Files are uploaded directly to Cloudflare R2 via presigned URLs (browser → R2, bypassing the web server). Inngest validates each file as it arrives. Admin reviews the batch and clicks "Import valid files" to run the import pipeline, which streams each CSV from R2 into `keyword_weekly_metrics`.
```

- [ ] **Step 2: Manual smoke test checklist (for the human, not run by tooling)**

After deploying, verify in production:

1. [ ] Upload one real 1.5GB file via `/admin/upload/single` → arrives, validates as `pass`, imports successfully
2. [ ] Verify row count in Neon matches file: `SELECT COUNT(*) FROM keyword_weekly_metrics WHERE source_file_id = '...'`
3. [ ] Visit `/admin/batches` and confirm the batch appears in history with status `imported`
4. [ ] Upload a second file for the SAME week → validation should fail with `WEEK_ALREADY_LOADED`
5. [ ] Click "Replace this week" → file re-validates → import succeeds → old data replaced
6. [ ] Upload 5 files at once via `/admin/upload` → all validate → import all → verify rows in DB

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document ingestion in README"
git push
```

---

## Acceptance criteria for Plan 2

Plan 2 is done when all of these are true:

- [ ] All three migrations applied in Neon; partitioned `keyword_weekly_metrics` with year partitions visible
- [ ] `pg_trgm` extension enabled
- [ ] `pnpm test` passes (target: 40+ tests across 12+ files)
- [ ] `pnpm test:integration` passes (rubric, ingestion, replace-week)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` succeeds
- [ ] Admin can upload one real 1.5GB CSV via deployed site — validation + import completes
- [ ] `keyword_weekly_metrics` row count matches uploaded file
- [ ] Admin can upload multiple files via `/admin/upload` — all validate, all import
- [ ] Duplicate-week upload fails with `WEEK_ALREADY_LOADED`
- [ ] Replace-week flow works end-to-end
- [ ] Batch health page and upload history page render correctly
- [ ] `summary/refresh-requested` event fires at end of each batch (visible in Inngest, no-op handler fine)

## What Plan 2 intentionally does NOT deliver

- `keyword_current_summary` refresh and table (Plan 3)
- Keyword explorer / detail page (Plan 3)
- Fake-volume evaluation (Plan 3 — columns exist but null in Plan 2)
- Substring search UI on search terms (index exists, querying is Plan 3)
- Watchlists, alerts, email (Plan 4)
- Admin settings / fake-volume rule editor (Plan 4)
