# Plan 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a Next.js app where the admin can sign in, upload a single Amazon SFR CSV, and approve schema version 1.

**Architecture:** Next.js App Router on Vercel. Clerk for auth, Neon Postgres with Drizzle ORM, Cloudflare R2 for raw file storage, Inngest for background jobs. The rubric upload runs as an Inngest pipeline that reads 100 sample rows from R2, detects schema shape, and writes a draft `schema_versions` row the admin approves in-app.

**Tech Stack:** Next.js 15, TypeScript, Drizzle ORM, Neon Postgres, Clerk, Inngest, Cloudflare R2 (S3-compatible), csv-parse, Vitest, Playwright, Tailwind CSS, shadcn/ui.

**Prerequisites before starting:** Accounts and credentials ready for Neon, Clerk, Cloudflare R2, Inngest, Vercel. Node.js 20+ and pnpm installed locally.

**Conventions used throughout this plan:**
- Package manager: `pnpm` (replace with `npm` or `yarn` if you prefer, but commands assume pnpm)
- Test runner: `vitest`
- Commit style: conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`)
- After every task, run `pnpm test` and `pnpm typecheck` before committing

---

## Task 1: Initialize Next.js project

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `postcss.config.mjs`, `tailwind.config.ts`

- [ ] **Step 1: Scaffold Next.js app in the existing directory**

From the repo root (`C:\Users\raw50\Amazon Keyword Analytics`):
```bash
pnpm dlx create-next-app@latest . --typescript --tailwind --app --eslint --src-dir=false --import-alias="@/*" --use-pnpm
```

When prompted about existing files (`.gitignore`, `docs/`), choose "No" to keep them.

- [ ] **Step 2: Verify dev server starts**

```bash
pnpm dev
```

Expected: `Local: http://localhost:3000` — visit and confirm default Next.js page renders. Kill with Ctrl+C.

- [ ] **Step 3: Update `app/page.tsx` to a minimal placeholder**

Replace contents of `app/page.tsx`:
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-semibold">Amazon SFR Analytics</h1>
    </main>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: scaffold Next.js app with TypeScript and Tailwind"
git push
```

---

## Task 2: Add developer tooling (Prettier, scripts, Vitest)

**Files:**
- Create: `.prettierrc`, `.prettierignore`, `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install dev dependencies**

```bash
pnpm add -D prettier vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom @types/node
```

- [ ] **Step 2: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
.next
node_modules
pnpm-lock.yaml
*.csv
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

- [ ] **Step 5: Create `vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 6: Update `package.json` scripts**

Add/replace inside `"scripts"`:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 7: Write and run a smoke test**

Create `lib/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run:
```bash
pnpm test
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "chore: add Prettier, Vitest, and dev scripts"
git push
```

---

## Task 3: Add typed environment variable handling

**Files:**
- Create: `lib/env.ts`, `.env.example`

- [ ] **Step 1: Install zod**

```bash
pnpm add zod
```

- [ ] **Step 2: Create `lib/env.ts`**

```ts
import { z } from 'zod';

const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  APP_PUBLIC_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const clientSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

function parseEnv() {
  const isServer = typeof window === 'undefined';
  const client = clientSchema.parse({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (!isServer) return { ...client };
  const server = serverSchema.parse(process.env);
  return { ...client, ...server };
}

export const env = parseEnv();
export type Env = ReturnType<typeof parseEnv>;
```

- [ ] **Step 3: Create `.env.example`**

```
# ============== APP ==============
APP_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# ============== NEON ==============
# Get from neon.tech dashboard → Connection Details → pooled connection string
DATABASE_URL=

# ============== CLERK ==============
# Get from clerk.com dashboard → API Keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
# Get from clerk.com dashboard → Webhooks → after creating endpoint
CLERK_WEBHOOK_SIGNING_SECRET=

# ============== CLOUDFLARE R2 ==============
# Get from Cloudflare dashboard → R2 → Manage R2 API Tokens
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=amazon-sfr-analytics-dev

# ============== INNGEST ==============
# Optional for local dev (the Inngest dev server runs without keys)
# Required in production — get from inngest.com dashboard
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# ============== ADMIN BOOTSTRAP ==============
# Email of the user to promote to admin on first sign-in
INITIAL_ADMIN_EMAIL=
```

- [ ] **Step 4: Create your real `.env.local`**

Copy `.env.example` to `.env.local` and leave values blank for now. You'll fill them in as you set up each service.

```bash
cp .env.example .env.local
```

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: add typed env var handling with zod"
git push
```

---

## Task 4: Set up Neon database and Drizzle ORM

**Files:**
- Create: `drizzle.config.ts`, `db/schema/index.ts`, `db/client.ts`

- [ ] **Step 1: Create Neon project**

Go to neon.tech → create project `amazon-sfr-analytics` → choose region close to Vercel deployment (e.g., US East). Grab the **pooled connection string** and paste into `.env.local` as `DATABASE_URL`.

- [ ] **Step 2: Install dependencies**

```bash
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D drizzle-kit
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

- [ ] **Step 4: Install dotenv for drizzle-kit**

```bash
pnpm add -D dotenv
```

- [ ] **Step 5: Create `db/client.ts`**

```ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { env } from '@/lib/env';
import * as schema from './schema';

const sql = neon(env.DATABASE_URL);
export const db = drizzle(sql, { schema });
```

- [ ] **Step 6: Create `db/schema/index.ts`** (empty placeholder for now)

```ts
// Schema tables will be added in subsequent tasks.
export {};
```

- [ ] **Step 7: Add Drizzle scripts to `package.json`**

Inside `"scripts"`:
```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

- [ ] **Step 8: Verify connection**

Create `db/ping.ts`:
```ts
import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const sql = neon(process.env.DATABASE_URL!);
const result = await sql`SELECT 1 as ok`;
console.log(result);
```

Run: `pnpm dlx tsx db/ping.ts`
Expected: `[ { ok: 1 } ]`. Delete `db/ping.ts` after verifying.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "chore: set up Neon and Drizzle ORM"
git push
```

---

## Task 5: Create core database schema — `users` table

**Files:**
- Create: `db/schema/users.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: Create `db/schema/users.ts`**

```ts
import { pgTable, uuid, varchar, timestamp, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'standard_user']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 255 }),
    role: userRoleEnum('role').notNull().default('standard_user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => ({
    clerkUserIdIdx: uniqueIndex('users_clerk_user_id_idx').on(t.clerkUserId),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

- [ ] **Step 2: Update `db/schema/index.ts`**

```ts
export * from './users';
```

- [ ] **Step 3: Generate and apply migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: migration file created in `db/migrations/`, applied successfully.

- [ ] **Step 4: Verify in Neon**

```bash
pnpm db:studio
```

Confirm `users` table with `user_role` enum exists. Close Studio.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(db): add users table with role enum"
git push
```

---

## Task 6: Create remaining foundation schema tables

**Files:**
- Create: `db/schema/schemaVersions.ts`, `db/schema/uploads.ts`, `db/schema/appSettings.ts`, `db/schema/auditLog.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: Create `db/schema/schemaVersions.ts`**

```ts
import { pgTable, uuid, integer, varchar, timestamp, pgEnum, jsonb, text } from 'drizzle-orm/pg-core';
import { users } from './users';

export const schemaVersionStatusEnum = pgEnum('schema_version_status', [
  'draft',
  'active',
  'retired',
]);

export const schemaVersions = pgTable('schema_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionNumber: integer('version_number').notNull(),
  status: schemaVersionStatusEnum('status').notNull().default('draft'),
  headerRowIndex: integer('header_row_index').notNull(),
  requiredColumnsJson: jsonb('required_columns_json').notNull(),
  headerHash: varchar('header_hash', { length: 64 }).notNull(),
  sampleFileId: uuid('sample_file_id'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SchemaVersion = typeof schemaVersions.$inferSelect;
export type NewSchemaVersion = typeof schemaVersions.$inferInsert;
```

- [ ] **Step 2: Create `db/schema/uploads.ts`**

```ts
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  jsonb,
  integer,
  boolean,
  date,
  text,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { schemaVersions } from './schemaVersions';

export const batchTypeEnum = pgEnum('batch_type', ['single_csv', 'zip_backfill']);
export const batchStatusEnum = pgEnum('batch_status', [
  'uploaded',
  'validating',
  'clean',
  'partial_review',
  'blocked',
  'importing',
  'imported',
  'imported_partial',
  'failed',
]);
export const validationStatusEnum = pgEnum('validation_status', [
  'pending',
  'pass',
  'pass_with_warnings',
  'fail',
  'import_failed',
  'imported',
]);
export const ingestionSeverityEnum = pgEnum('ingestion_severity', ['error', 'warning', 'info']);

export const uploadBatches = pgTable('upload_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchType: batchTypeEnum('batch_type').notNull(),
  status: batchStatusEnum('status').notNull().default('uploaded'),
  schemaVersionId: uuid('schema_version_id').references(() => schemaVersions.id),
  failureThresholdPct: integer('failure_threshold_pct').notNull().default(10),
  totalFiles: integer('total_files').notNull().default(0),
  passedFiles: integer('passed_files').notNull().default(0),
  warningFiles: integer('warning_files').notNull().default(0),
  failedFiles: integer('failed_files').notNull().default(0),
  createdByUserId: uuid('created_by_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  summaryJson: jsonb('summary_json'),
});

export const uploadedFiles = pgTable('uploaded_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => uploadBatches.id),
  schemaVersionId: uuid('schema_version_id').references(() => schemaVersions.id),
  storageKey: varchar('storage_key', { length: 1024 }).notNull(),
  originalFilename: varchar('original_filename', { length: 512 }).notNull(),
  fileChecksum: varchar('file_checksum', { length: 64 }),
  weekEndDate: date('week_end_date'),
  weekStartDate: date('week_start_date'),
  reportingDateRaw: varchar('reporting_date_raw', { length: 64 }),
  metadataRowRaw: text('metadata_row_raw'),
  validationStatus: validationStatusEnum('validation_status').notNull().default('pending'),
  validationErrorsJson: jsonb('validation_errors_json'),
  validationWarningsJson: jsonb('validation_warnings_json'),
  validationInfoJson: jsonb('validation_info_json'),
  rowCountRaw: integer('row_count_raw'),
  rowCountLoaded: integer('row_count_loaded'),
  isReplacement: boolean('is_replacement').notNull().default(false),
  replacesFileId: uuid('replaces_file_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  importedAt: timestamp('imported_at', { withTimezone: true }),
});

export const ingestionErrors = pgTable('ingestion_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadedFileId: uuid('uploaded_file_id')
    .notNull()
    .references(() => uploadedFiles.id),
  severity: ingestionSeverityEnum('severity').notNull(),
  code: varchar('code', { length: 64 }).notNull(),
  message: text('message').notNull(),
  rowNumber: integer('row_number'),
  columnName: varchar('column_name', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UploadBatch = typeof uploadBatches.$inferSelect;
export type UploadedFile = typeof uploadedFiles.$inferSelect;
export type IngestionError = typeof ingestionErrors.$inferSelect;
```

- [ ] **Step 3: Create `db/schema/appSettings.ts`**

```ts
import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const appSettings = pgTable('app_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 128 }).notNull().unique(),
  valueJson: jsonb('value_json').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Create `db/schema/auditLog.ts`**

```ts
import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 128 }).notNull(),
  entityType: varchar('entity_type', { length: 128 }),
  entityId: uuid('entity_id'),
  metadataJson: jsonb('metadata_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Update `db/schema/index.ts`**

```ts
export * from './users';
export * from './schemaVersions';
export * from './uploads';
export * from './appSettings';
export * from './auditLog';
```

- [ ] **Step 6: Generate and apply migration**

```bash
pnpm db:generate
pnpm db:migrate
```

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat(db): add schema_versions, uploads, app_settings, audit_log tables"
git push
```

---

## Task 7: Seed initial app_settings

**Files:**
- Create: `db/seed.ts`

- [ ] **Step 1: Install tsx for seed execution**

```bash
pnpm add -D tsx
```

- [ ] **Step 2: Create `db/seed.ts`**

```ts
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { appSettings } from './schema';
import { sql } from 'drizzle-orm';

const DEFAULT_SETTINGS = [
  { key: 'batch_failure_threshold_pct', valueJson: { value: 10 } },
  { key: 'unranked_comparison_value', valueJson: { value: 1000000 } },
  { key: 'row_count_anomaly_low_pct', valueJson: { value: 50 } },
  { key: 'row_count_anomaly_high_pct', valueJson: { value: 200 } },
];

async function main() {
  const client = neon(process.env.DATABASE_URL!);
  const db = drizzle(client);
  for (const s of DEFAULT_SETTINGS) {
    await db.insert(appSettings).values(s).onConflictDoNothing({ target: appSettings.key });
  }
  console.log('Seeded app_settings');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add seed script to `package.json`**

```json
{
  "scripts": {
    "db:seed": "tsx db/seed.ts"
  }
}
```

- [ ] **Step 4: Run seed**

```bash
pnpm db:seed
```

Expected: `Seeded app_settings`. Verify rows exist in `pnpm db:studio`.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(db): seed default app_settings"
git push
```

---

## Task 8: Install and configure Clerk

**Files:**
- Create: `middleware.ts`, `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx`
- Modify: `app/layout.tsx`, `.env.local`

- [ ] **Step 1: Create Clerk application**

Go to clerk.com → create application `amazon-sfr-analytics` → enable Email + any social providers you want. Copy `Publishable key` and `Secret key` into `.env.local`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

- [ ] **Step 2: Install Clerk**

```bash
pnpm add @clerk/nextjs svix
```

- [ ] **Step 3: Update `app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Amazon SFR Analytics',
  description: 'Weekly Amazon Search Frequency Rank analytics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 4: Create `middleware.ts`**

```ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/admin(.*)', '/app(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};
```

- [ ] **Step 5: Create `app/sign-in/[[...sign-in]]/page.tsx`**

```tsx
import { SignIn } from '@clerk/nextjs';

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn />
    </div>
  );
}
```

- [ ] **Step 6: Create `app/sign-up/[[...sign-up]]/page.tsx`**

```tsx
import { SignUp } from '@clerk/nextjs';

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignUp />
    </div>
  );
}
```

- [ ] **Step 7: Add Clerk URLs to `.env.local`**

```
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/app
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/app
```

- [ ] **Step 8: Smoke test**

```bash
pnpm dev
```

Visit `http://localhost:3000/sign-in` — Clerk UI should render. Sign up with a test email. After sign-up, Clerk redirects to `/app` which 404s — that's expected (we'll add the route in the next task).

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(auth): configure Clerk with sign-in/up pages and route protection"
git push
```

---

## Task 9: Build `users` sync — upsert helper

**Files:**
- Create: `lib/auth/syncUser.ts`, `lib/auth/syncUser.test.ts`

- [ ] **Step 1: Write failing test**

Create `lib/auth/syncUser.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncUserFromClerk } from './syncUser';

const mockDb = {
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  query: { users: { findFirst: vi.fn() } },
};

vi.mock('@/db/client', () => ({ db: mockDb }));

describe('syncUserFromClerk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a new user when clerk_user_id does not exist', async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce(undefined);
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 'new-uuid', clerkUserId: 'user_123' }]),
      }),
    });

    const result = await syncUserFromClerk({
      clerkUserId: 'user_123',
      email: 'test@example.com',
      name: 'Test User',
    });

    expect(result.clerkUserId).toBe('user_123');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('updates an existing user when clerk_user_id exists', async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce({
      id: 'existing-uuid',
      clerkUserId: 'user_123',
      email: 'old@example.com',
      role: 'standard_user',
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          returning: vi
            .fn()
            .mockResolvedValueOnce([{ id: 'existing-uuid', email: 'new@example.com' }]),
        }),
      }),
    });

    const result = await syncUserFromClerk({
      clerkUserId: 'user_123',
      email: 'new@example.com',
      name: 'Updated',
    });

    expect(result.email).toBe('new@example.com');
    expect(mockDb.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test lib/auth/syncUser.test.ts
```

Expected: fails with "module not found".

- [ ] **Step 3: Implement `lib/auth/syncUser.ts`**

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

export interface SyncUserInput {
  clerkUserId: string;
  email: string;
  name?: string | null;
}

export async function syncUserFromClerk(input: SyncUserInput): Promise<User> {
  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, input.clerkUserId),
  });

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email: input.email,
        name: input.name ?? existing.name,
      })
      .where(eq(users.clerkUserId, input.clerkUserId))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name ?? null,
    })
    .returning();
  return created;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test lib/auth/syncUser.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(auth): add syncUserFromClerk helper"
git push
```

---

## Task 10: Build Clerk webhook endpoint

**Files:**
- Create: `app/api/webhooks/clerk/route.ts`, `app/api/webhooks/clerk/route.test.ts`

- [ ] **Step 1: Configure Clerk webhook endpoint (externally)**

In Clerk dashboard → Webhooks → Add Endpoint:
- URL: `https://<your-ngrok-or-deployed-url>/api/webhooks/clerk` (use ngrok for local dev)
- Events: `user.created`, `user.updated`, `user.deleted`
- Copy the Signing Secret into `.env.local` as `CLERK_WEBHOOK_SIGNING_SECRET`

For now you can skip this step and fill in a dummy signing secret. We'll register the real webhook during deployment.

- [ ] **Step 2: Write the failing test**

Create `app/api/webhooks/clerk/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

vi.mock('svix', () => ({
  Webhook: class {
    constructor(public secret: string) {}
    verify(body: string, headers: Record<string, string>) {
      if (headers['svix-signature'] === 'bad') throw new Error('invalid signature');
      return JSON.parse(body);
    }
  },
}));

vi.mock('@/lib/auth/syncUser', () => ({
  syncUserFromClerk: vi.fn().mockResolvedValue({ id: 'uuid', clerkUserId: 'user_123' }),
}));

vi.mock('@/lib/env', () => ({
  env: { CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test' },
}));

function makeRequest(body: unknown, signature = 'good') {
  return new Request('http://localhost/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_1',
      'svix-timestamp': String(Date.now()),
      'svix-signature': signature,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/webhooks/clerk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects requests with invalid signature', async () => {
    const req = makeRequest({ type: 'user.created', data: {} }, 'bad');
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('processes user.created event', async () => {
    const { syncUserFromClerk } = await import('@/lib/auth/syncUser');
    const req = makeRequest({
      type: 'user.created',
      data: {
        id: 'user_123',
        email_addresses: [{ id: 'a', email_address: 'test@x.com' }],
        primary_email_address_id: 'a',
        first_name: 'Test',
        last_name: 'User',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(syncUserFromClerk).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      email: 'test@x.com',
      name: 'Test User',
    });
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm test app/api/webhooks/clerk
```

Expected: fails with "module not found".

- [ ] **Step 4: Implement the route**

Create `app/api/webhooks/clerk/route.ts`:
```ts
import { Webhook } from 'svix';
import { env } from '@/lib/env';
import { syncUserFromClerk } from '@/lib/auth/syncUser';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

interface ClerkUserData {
  id: string;
  email_addresses: ClerkEmailAddress[];
  primary_email_address_id: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface ClerkEvent {
  type: 'user.created' | 'user.updated' | 'user.deleted';
  data: ClerkUserData;
}

function extractEmail(data: ClerkUserData): string {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? '';
}

function extractName(data: ClerkUserData): string | null {
  const parts = [data.first_name, data.last_name].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export async function POST(req: Request): Promise<Response> {
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(env.CLERK_WEBHOOK_SIGNING_SECRET);

  let event: ClerkEvent;
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkEvent;
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'user.created' || event.type === 'user.updated') {
    await syncUserFromClerk({
      clerkUserId: event.data.id,
      email: extractEmail(event.data),
      name: extractName(event.data),
    });
  } else if (event.type === 'user.deleted') {
    await db.delete(users).where(eq(users.clerkUserId, event.data.id));
  }

  return new Response('ok', { status: 200 });
}
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm test app/api/webhooks/clerk
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(auth): add Clerk webhook endpoint with signature verification"
git push
```

---

## Task 11: Build role check helper and admin route guard

**Files:**
- Create: `lib/auth/getCurrentUser.ts`, `lib/auth/requireAdmin.ts`, `lib/auth/requireAdmin.test.ts`

- [ ] **Step 1: Create `lib/auth/getCurrentUser.ts`**

```ts
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

export async function getCurrentUser(): Promise<User | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  return user ?? null;
}
```

- [ ] **Step 2: Write failing test for `requireAdmin`**

Create `lib/auth/requireAdmin.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCurrentUser = vi.fn();
vi.mock('./getCurrentUser', () => ({ getCurrentUser: mockGetCurrentUser }));

import { requireAdmin, AuthError } from './requireAdmin';

describe('requireAdmin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws AuthError when no user is logged in', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    await expect(requireAdmin()).rejects.toThrow(AuthError);
  });

  it('throws AuthError when user is not admin', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'standard_user' });
    await expect(requireAdmin()).rejects.toThrow(AuthError);
  });

  it('returns user when user is admin', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'admin' });
    const user = await requireAdmin();
    expect(user.role).toBe('admin');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm test lib/auth/requireAdmin
```

- [ ] **Step 4: Implement `lib/auth/requireAdmin.ts`**

```ts
import { getCurrentUser } from './getCurrentUser';
import type { User } from '@/db/schema';

export class AuthError extends Error {
  constructor(
    public code: 'UNAUTHENTICATED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in');
  if (user.role !== 'admin') throw new AuthError('FORBIDDEN', 'Admin only');
  return user;
}
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm test lib/auth/requireAdmin
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(auth): add getCurrentUser and requireAdmin helpers"
git push
```

---

## Task 12: Build first-admin bootstrap script

**Files:**
- Create: `scripts/promoteAdmin.ts`

- [ ] **Step 1: Create `scripts/promoteAdmin.ts`**

```ts
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  if (!email) {
    console.error('INITIAL_ADMIN_EMAIL env var not set');
    process.exit(1);
  }
  const client = neon(process.env.DATABASE_URL!);
  const db = drizzle(client, { schema: { users } });
  const [updated] = await db
    .update(users)
    .set({ role: 'admin' })
    .where(eq(users.email, email))
    .returning();
  if (!updated) {
    console.error(`No user found with email ${email}. Sign in first to create the user row.`);
    process.exit(1);
  }
  console.log(`Promoted ${email} to admin`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add script to `package.json`**

```json
{
  "scripts": {
    "admin:promote": "tsx scripts/promoteAdmin.ts"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "feat(auth): add promoteAdmin script for first admin bootstrap"
git push
```

---

## Task 13: Set up Cloudflare R2

**Files:**
- Create: `lib/storage/r2.ts`, `lib/storage/r2.test.ts`

- [ ] **Step 1: Create R2 bucket**

Cloudflare dashboard → R2 → Create bucket `amazon-sfr-analytics-dev`. Then Manage R2 API Tokens → Create API Token with `Object Read & Write` scope. Copy credentials into `.env.local`.

- [ ] **Step 2: Install AWS SDK (R2 is S3-compatible)**

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 3: Create `lib/storage/r2.ts`**

```ts
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2(key: string, body: Buffer | Uint8Array, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getPresignedUploadUrl(key: string, contentType: string, expiresInSec = 900) {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, cmd, { expiresIn: expiresInSec });
}

export async function downloadFromR2(key: string): Promise<Buffer> {
  const result = await r2.send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }),
  );
  const chunks: Buffer[] = [];
  const stream = result.Body as NodeJS.ReadableStream;
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Smoke test R2 connection**

Create a one-off script `scripts/testR2.ts`:
```ts
import 'dotenv/config';
import { uploadToR2, downloadFromR2 } from '../lib/storage/r2';

const key = `test/ping-${Date.now()}.txt`;
await uploadToR2(key, Buffer.from('hello r2'), 'text/plain');
const result = await downloadFromR2(key);
console.log('Downloaded:', result.toString());
```

Run: `pnpm dlx tsx scripts/testR2.ts`
Expected: `Downloaded: hello r2`. Delete `scripts/testR2.ts` after.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(storage): add R2 client and upload/download helpers"
git push
```

---

## Task 14: Install and configure Inngest

**Files:**
- Create: `inngest/client.ts`, `inngest/functions/index.ts`, `app/api/inngest/route.ts`

- [ ] **Step 1: Install Inngest**

```bash
pnpm add inngest
```

- [ ] **Step 2: Create `inngest/client.ts`**

```ts
import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'amazon-sfr-analytics',
  name: 'Amazon SFR Analytics',
});
```

- [ ] **Step 3: Create `inngest/functions/index.ts`** (empty for now)

```ts
export const functions = [];
```

- [ ] **Step 4: Create `app/api/inngest/route.ts`**

```ts
import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { functions } from '@/inngest/functions';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
```

- [ ] **Step 5: Add Inngest dev-server script**

Add to `package.json`:
```json
{
  "scripts": {
    "inngest:dev": "pnpm dlx inngest-cli@latest dev -u http://localhost:3000/api/inngest"
  }
}
```

- [ ] **Step 6: Verify Inngest is wired up**

Run in one terminal: `pnpm dev`
Run in another: `pnpm inngest:dev`
Visit `http://localhost:8288` — Inngest dashboard should show zero functions registered (expected; we'll add one next).

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore(inngest): scaffold Inngest client and API route"
git push
```

---

## Task 15: Build CSV parser — metadata row and header extraction

**Files:**
- Create: `lib/csv/parseRubric.ts`, `lib/csv/parseRubric.test.ts`, `lib/csv/fixtures/valid-sample.csv`, `lib/csv/fixtures/missing-header.csv`, `lib/csv/fixtures/mixed-dates.csv`

- [ ] **Step 1: Install csv-parse**

```bash
pnpm add csv-parse
```

- [ ] **Step 2: Create `lib/csv/fixtures/valid-sample.csv`** (copy the real sample)

```bash
mkdir -p lib/csv/fixtures
cp "C:/Users/raw50/Downloads/US_Top_Search_Terms_Simple_Week_2026_04_11.csv" lib/csv/fixtures/valid-sample.csv
```

- [ ] **Step 3: Create `lib/csv/fixtures/missing-header.csv`**

```
"Reporting Range=[""Weekly""]","Select week=[""Week 15 | 2026-04-05 - 2026-04-11 2026""]",,,,,,,,,,,,,,,,,,,
Some Random Header,Not A Real Header
1,data
```

- [ ] **Step 4: Create `lib/csv/fixtures/mixed-dates.csv`**

```
"Reporting Range=[""Weekly""]","Select week=[""Week 15 | 2026-04-05 - 2026-04-11 2026""]",,,,,,,,,,,,,,,,,,,
Search Frequency Rank,Search Term,Top Clicked Brand #1,Top Clicked Brands #2,Top Clicked Brands #3,Top Clicked Category #1,Top Clicked Category #2,Top Clicked Category #3,Top Clicked Product #1: ASIN,Top Clicked Product #1: Product Title,Top Clicked Product #1: Click Share,Top Clicked Product #1: Conversion Share,Top Clicked Product #2: ASIN,Top Clicked Product #2: Product Title,Top Clicked Product #2: Click Share,Top Clicked Product #2: Conversion Share,Top Clicked Product #3: ASIN,Top Clicked Product #3: Product Title,Top Clicked Product #3: Click Share,Top Clicked Product #3: Conversion Share,Reporting Date
1,term-a,,,,,,,,,,,,,,,,,,,4/11/2026
2,term-b,,,,,,,,,,,,,,,,,,,4/04/2026
```

- [ ] **Step 5: Write failing tests**

Create `lib/csv/parseRubric.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseRubric, RubricParseError } from './parseRubric';

function loadFixture(name: string): Buffer {
  return readFileSync(path.join(__dirname, 'fixtures', name));
}

describe('parseRubric', () => {
  it('extracts metadata, header, and sample rows from valid file', async () => {
    const buf = loadFixture('valid-sample.csv');
    const result = await parseRubric(buf, { sampleSize: 50 });
    expect(result.metadataRowRaw).toContain('Reporting Range');
    expect(result.weekEndDate).toBe('2026-04-11');
    expect(result.weekStartDate).toBe('2026-04-05');
    expect(result.reportingDateRaw).toBe('4/11/2026');
    expect(result.headers).toHaveLength(21);
    expect(result.headers[0]).toBe('Search Frequency Rank');
    expect(result.headers[20]).toBe('Reporting Date');
    expect(result.sampleRows.length).toBeGreaterThan(10);
  });

  it('throws when required header is missing', async () => {
    const buf = loadFixture('missing-header.csv');
    await expect(parseRubric(buf)).rejects.toThrow(RubricParseError);
  });

  it('throws when reporting dates are inconsistent', async () => {
    const buf = loadFixture('mixed-dates.csv');
    await expect(parseRubric(buf)).rejects.toThrow(/mixed reporting date/i);
  });
});
```

- [ ] **Step 6: Run tests, verify they fail**

```bash
pnpm test lib/csv/parseRubric
```

- [ ] **Step 7: Implement `lib/csv/parseRubric.ts`**

```ts
import { parse } from 'csv-parse/sync';

export const REQUIRED_COLUMNS = [
  'Search Frequency Rank',
  'Search Term',
  'Top Clicked Brand #1',
  'Top Clicked Brands #2',
  'Top Clicked Brands #3',
  'Top Clicked Category #1',
  'Top Clicked Category #2',
  'Top Clicked Category #3',
  'Top Clicked Product #1: ASIN',
  'Top Clicked Product #1: Product Title',
  'Top Clicked Product #1: Click Share',
  'Top Clicked Product #1: Conversion Share',
  'Top Clicked Product #2: ASIN',
  'Top Clicked Product #2: Product Title',
  'Top Clicked Product #2: Click Share',
  'Top Clicked Product #2: Conversion Share',
  'Top Clicked Product #3: ASIN',
  'Top Clicked Product #3: Product Title',
  'Top Clicked Product #3: Click Share',
  'Top Clicked Product #3: Conversion Share',
  'Reporting Date',
] as const;

export class RubricParseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RubricParseError';
  }
}

export interface RubricParseResult {
  metadataRowRaw: string;
  headers: string[];
  headerRowIndex: number;
  weekStartDate: string | null;
  weekEndDate: string | null;
  reportingDateRaw: string | null;
  sampleRows: Record<string, string>[];
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseReportingDate(value: string): string {
  // M/D/YYYY → YYYY-MM-DD
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new RubricParseError('INVALID_DATE', `Unrecognized date format: ${value}`);
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function extractWeekRange(metadata: string): {
  weekStartDate: string | null;
  weekEndDate: string | null;
} {
  // "Select week=["Week 15 | 2026-04-05 - 2026-04-11 2026"]"
  const m = metadata.match(/Select week=\[""Week \d+ \| (\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2})/);
  if (!m) return { weekStartDate: null, weekEndDate: null };
  return { weekStartDate: m[1], weekEndDate: m[2] };
}

export async function parseRubric(
  buf: Buffer,
  opts: { sampleSize?: number } = {},
): Promise<RubricParseResult> {
  const sampleSize = opts.sampleSize ?? 100;
  const text = stripBom(buf.toString('utf-8'));

  const allRows: string[][] = parse(text, {
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  if (allRows.length < 2) {
    throw new RubricParseError('EMPTY_FILE', 'File has fewer than 2 rows');
  }

  const metadataRow = allRows[0];
  const headerRow = allRows[1];
  const metadataRowRaw = metadataRow.map((c) => JSON.stringify(c)).join(',');

  // Validate headers
  for (const required of REQUIRED_COLUMNS) {
    if (!headerRow.includes(required)) {
      throw new RubricParseError(
        'MISSING_HEADER',
        `Required header not found: ${required}`,
      );
    }
  }

  const { weekStartDate, weekEndDate } = extractWeekRange(metadataRowRaw);

  const dataRowsRaw = allRows.slice(2, 2 + sampleSize);
  const sampleRows: Record<string, string>[] = dataRowsRaw.map((row) => {
    const obj: Record<string, string> = {};
    headerRow.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  // Validate reporting dates
  const reportingDateIdx = headerRow.indexOf('Reporting Date');
  const reportingDates = new Set(dataRowsRaw.map((r) => r[reportingDateIdx]).filter(Boolean));
  if (reportingDates.size > 1) {
    throw new RubricParseError(
      'MIXED_REPORTING_DATE',
      `mixed reporting date values found: ${Array.from(reportingDates).join(', ')}`,
    );
  }

  const reportingDateRaw = reportingDates.values().next().value ?? null;
  const reportingDateIso = reportingDateRaw ? parseReportingDate(reportingDateRaw) : null;

  // Cross-validate: reporting date should match weekEndDate if both present
  if (reportingDateIso && weekEndDate && reportingDateIso !== weekEndDate) {
    throw new RubricParseError(
      'DATE_MISMATCH',
      `Reporting date ${reportingDateRaw} does not match week end date ${weekEndDate}`,
    );
  }

  return {
    metadataRowRaw,
    headers: headerRow,
    headerRowIndex: 1,
    weekStartDate,
    weekEndDate: weekEndDate ?? reportingDateIso,
    reportingDateRaw,
    sampleRows,
  };
}
```

- [ ] **Step 8: Run tests, verify they pass**

```bash
pnpm test lib/csv/parseRubric
```

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(csv): implement rubric parser with metadata and header validation"
git push
```

---

## Task 16: Build the rubric Inngest function

**Files:**
- Create: `inngest/functions/rubric.ts`, `inngest/functions/rubric.test.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Write the failing test**

Create `inngest/functions/rubric.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDownloadFromR2 = vi.fn();
const mockParseRubric = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: mockDownloadFromR2 }));
vi.mock('@/lib/csv/parseRubric', () => ({ parseRubric: mockParseRubric }));
vi.mock('@/db/client', () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

import { processRubricUpload } from './rubric';

describe('processRubricUpload step function', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads, parses, and creates a draft schema version', async () => {
    mockDownloadFromR2.mockResolvedValueOnce(Buffer.from('fake'));
    mockParseRubric.mockResolvedValueOnce({
      metadataRowRaw: 'meta',
      headers: Array(21).fill('col'),
      headerRowIndex: 1,
      weekStartDate: '2026-04-05',
      weekEndDate: '2026-04-11',
      reportingDateRaw: '4/11/2026',
      sampleRows: [{}],
    });
    mockInsert.mockReturnValueOnce({
      values: vi.fn().mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 'schema-v1-uuid', versionNumber: 1 }]),
      }),
    });

    const result = await processRubricUpload({
      uploadedFileId: 'file-uuid',
      storageKey: 'uploads/test.csv',
    });

    expect(result.schemaVersionId).toBe('schema-v1-uuid');
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/test.csv');
    expect(mockParseRubric).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Implement `inngest/functions/rubric.ts`**

```ts
import { createHash } from 'crypto';
import { inngest } from '../client';
import { downloadFromR2 } from '@/lib/storage/r2';
import { parseRubric, REQUIRED_COLUMNS } from '@/lib/csv/parseRubric';
import { db } from '@/db/client';
import { schemaVersions, uploadedFiles } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export interface RubricStepInput {
  uploadedFileId: string;
  storageKey: string;
}

export interface RubricStepOutput {
  schemaVersionId: string;
}

/**
 * Pure pipeline logic, testable without Inngest runtime.
 */
export async function processRubricUpload(input: RubricStepInput): Promise<RubricStepOutput> {
  const buf = await downloadFromR2(input.storageKey);
  const parsed = await parseRubric(buf, { sampleSize: 100 });

  // Determine next version number
  const [{ nextVersion }] = (await db.execute(
    sql`SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion" FROM schema_versions`,
  )) as unknown as [{ nextVersion: number }];

  const headerHash = createHash('sha256').update(parsed.headers.join('|')).digest('hex');

  const [version] = await db
    .insert(schemaVersions)
    .values({
      versionNumber: nextVersion,
      status: 'draft',
      headerRowIndex: parsed.headerRowIndex,
      requiredColumnsJson: { columns: REQUIRED_COLUMNS, detected: parsed.headers },
      headerHash,
      sampleFileId: input.uploadedFileId,
      notes: `Week: ${parsed.weekStartDate} – ${parsed.weekEndDate}`,
    })
    .returning();

  // Link uploaded file to schema version
  await db
    .update(uploadedFiles)
    .set({
      schemaVersionId: version.id,
      weekEndDate: parsed.weekEndDate,
      weekStartDate: parsed.weekStartDate,
      reportingDateRaw: parsed.reportingDateRaw,
      metadataRowRaw: parsed.metadataRowRaw,
    })
    .where(eq(uploadedFiles.id, input.uploadedFileId));

  return { schemaVersionId: version.id };
}

export const rubricUploadedFn = inngest.createFunction(
  { id: 'rubric-uploaded', name: 'Process rubric upload' },
  { event: 'csv/rubric.uploaded' },
  async ({ event, step }) => {
    const result = await step.run('process-rubric', () =>
      processRubricUpload({
        uploadedFileId: event.data.uploadedFileId,
        storageKey: event.data.storageKey,
      }),
    );
    return result;
  },
);
```

- [ ] **Step 4: Register the function**

Update `inngest/functions/index.ts`:
```ts
import { rubricUploadedFn } from './rubric';

export const functions = [rubricUploadedFn];
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm test inngest/functions/rubric
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(inngest): add rubric upload pipeline"
git push
```

---

## Task 17: Build admin layout and route protection

**Files:**
- Create: `app/admin/layout.tsx`, `app/admin/page.tsx`, `app/app/page.tsx`, `app/(marketing)/page.tsx`
- Delete: `app/page.tsx` (replaced)

- [ ] **Step 1: Delete old `app/page.tsx`**

```bash
rm app/page.tsx
```

- [ ] **Step 2: Create a marketing/home route group**

Create `app/(marketing)/page.tsx`:
```tsx
import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">Amazon SFR Analytics</h1>
      <div className="flex gap-4">
        <Link className="underline" href="/sign-in">
          Sign in
        </Link>
        <Link className="underline" href="/sign-up">
          Sign up
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Create standard-user home at `app/app/page.tsx`**

```tsx
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { redirect } from 'next/navigation';

export default async function AppHome() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Welcome, {user.name ?? user.email}</h1>
      <p className="mt-4 text-gray-600">
        Analytics will be available in Phase 3. For now this is a placeholder page.
      </p>
      {user.role === 'admin' && (
        <p className="mt-4">
          <a href="/admin" className="underline">
            Go to admin
          </a>
        </p>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Create `app/admin/layout.tsx`**

```tsx
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/app');
    }
    throw e;
  }
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4">
        <nav className="flex flex-col gap-2">
          <Link href="/admin" className="hover:underline">
            Overview
          </Link>
          <Link href="/admin/rubric" className="hover:underline">
            Schema rubric
          </Link>
        </nav>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 5: Create `app/admin/page.tsx`**

```tsx
export default function AdminHome() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Admin</h1>
      <p className="mt-4 text-gray-600">Start with the Schema rubric to approve the CSV format.</p>
    </div>
  );
}
```

- [ ] **Step 6: Smoke test**

```bash
pnpm dev
```

- Unauthenticated visit to `/admin` → redirects to `/sign-in`
- Authenticated standard user visit to `/admin` → redirects to `/app`
- Promote your Clerk user to admin via `pnpm admin:promote`, then visit `/admin` → renders

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat(admin): add admin layout with RBAC guard"
git push
```

---

## Task 18: Build rubric upload API route

**Files:**
- Create: `app/api/admin/schema/rubric/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { uploadToR2 } from '@/lib/storage/r2';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';
import { createHash } from 'crypto';

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

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(buf).digest('hex');
  const storageKey = `rubrics/${checksum}.csv`;
  await uploadToR2(storageKey, buf, 'text/csv');

  // Create a batch row and file row
  const [batch] = await db
    .insert(uploadBatches)
    .values({
      batchType: 'single_csv',
      status: 'validating',
      totalFiles: 1,
      createdByUserId: user.id,
    })
    .returning();

  const [uploadedFile] = await db
    .insert(uploadedFiles)
    .values({
      batchId: batch.id,
      storageKey,
      originalFilename: file.name,
      fileChecksum: checksum,
      validationStatus: 'pending',
    })
    .returning();

  // Trigger Inngest
  await inngest.send({
    name: 'csv/rubric.uploaded',
    data: { uploadedFileId: uploadedFile.id, storageKey },
  });

  return NextResponse.json({ batchId: batch.id, uploadedFileId: uploadedFile.id });
}

export const runtime = 'nodejs';
export const maxDuration = 30;
```

- [ ] **Step 2: Commit**

```bash
git add .
git commit -m "feat(api): add rubric upload endpoint"
git push
```

---

## Task 19: Build rubric upload UI

**Files:**
- Create: `app/admin/rubric/page.tsx`, `app/admin/rubric/RubricUploader.tsx`, `app/admin/rubric/[id]/page.tsx`

- [ ] **Step 1: Create `app/admin/rubric/RubricUploader.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RubricUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/schema/rubric', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Upload failed');
      }
      const { uploadedFileId } = await res.json();
      router.push(`/admin/rubric/${uploadedFileId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={handleUpload} className="flex max-w-md flex-col gap-4">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />
      <button
        type="submit"
        disabled={!file || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : 'Upload rubric CSV'}
      </button>
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 2: Create `app/admin/rubric/page.tsx`**

```tsx
import { RubricUploader } from './RubricUploader';

export default function RubricPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Schema rubric</h1>
      <p className="mt-2 text-gray-600">
        Upload a single Amazon SFR CSV. We will detect the schema and let you approve it as version 1.
      </p>
      <div className="mt-6">
        <RubricUploader />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `app/admin/rubric/[id]/page.tsx`**

```tsx
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles, schemaVersions } from '@/db/schema';
import { notFound } from 'next/navigation';
import { ApproveSchemaButton } from './ApproveSchemaButton';

export default async function RubricDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, id),
  });
  if (!file) notFound();

  const schemaVersion = file.schemaVersionId
    ? await db.query.schemaVersions.findFirst({ where: eq(schemaVersions.id, file.schemaVersionId) })
    : null;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Rubric preview</h1>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt>File</dt>
        <dd>{file.originalFilename}</dd>
        <dt>Week end</dt>
        <dd>{file.weekEndDate ?? '—'}</dd>
        <dt>Reporting date</dt>
        <dd>{file.reportingDateRaw ?? '—'}</dd>
        <dt>Schema version</dt>
        <dd>{schemaVersion ? `v${schemaVersion.versionNumber} (${schemaVersion.status})` : 'processing…'}</dd>
      </dl>
      {schemaVersion?.status === 'draft' && (
        <div className="mt-6">
          <ApproveSchemaButton schemaVersionId={schemaVersion.id} fileId={file.id} />
        </div>
      )}
      {!schemaVersion && (
        <p className="mt-4 text-gray-500">Processing… refresh in a few seconds.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `app/admin/rubric/[id]/ApproveSchemaButton.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ApproveSchemaButton({
  schemaVersionId,
  fileId,
}: {
  schemaVersionId: string;
  fileId: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleApprove() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/schema/${schemaVersionId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Approval failed');
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleApprove}
        disabled={submitting}
        className="rounded bg-green-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? 'Approving…' : 'Approve as active schema'}
      </button>
      {error && <p className="mt-2 text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(admin): add rubric upload UI and schema preview page"
git push
```

---

## Task 20: Build schema approval API

**Files:**
- Create: `app/api/admin/schema/[id]/approve/route.ts`, `app/api/admin/schema/[id]/approve/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/api/admin/schema/[id]/approve/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequireAdmin = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockInngestSend = vi.fn();
const mockFindFirstSchema = vi.fn();
const mockFindFirstFile = vi.fn();

vi.mock('@/lib/auth/requireAdmin', () => ({
  requireAdmin: mockRequireAdmin,
  AuthError: class AuthError extends Error {},
}));

vi.mock('@/db/client', () => ({
  db: {
    update: (...a: unknown[]) => mockUpdate(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      schemaVersions: { findFirst: mockFindFirstSchema },
      uploadedFiles: { findFirst: mockFindFirstFile },
    },
  },
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: mockInngestSend },
}));

import { POST } from './route';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/admin/schema/v1/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/schema/[id]/approve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('activates the schema and queues data import of the rubric file', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-uuid' });
    mockFindFirstSchema.mockResolvedValueOnce({ id: 'sv-uuid', status: 'draft', versionNumber: 1 });
    mockFindFirstFile.mockResolvedValueOnce({
      id: 'file-uuid',
      storageKey: 'rubrics/abc.csv',
    });
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    const res = await POST(makeRequest({ fileId: 'file-uuid' }), {
      params: Promise.resolve({ id: 'sv-uuid' }),
    });

    expect(res.status).toBe(200);
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'csv/single.uploaded' }),
    );
  });

  it('rejects when schema version is not in draft', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-uuid' });
    mockFindFirstSchema.mockResolvedValueOnce({ id: 'sv-uuid', status: 'active' });

    const res = await POST(makeRequest({ fileId: 'file-uuid' }), {
      params: Promise.resolve({ id: 'sv-uuid' }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Implement the route**

Create `app/api/admin/schema/[id]/approve/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { eq, and, ne } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { schemaVersions, auditLog, uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
      );
    }
    throw e;
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { fileId?: string };
  if (!body.fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  const version = await db.query.schemaVersions.findFirst({
    where: eq(schemaVersions.id, id),
  });
  if (!version) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (version.status !== 'draft') {
    return NextResponse.json({ error: 'schema is not in draft state' }, { status: 400 });
  }

  // Retire any currently active version
  await db
    .update(schemaVersions)
    .set({ status: 'retired' })
    .where(and(eq(schemaVersions.status, 'active'), ne(schemaVersions.id, id)));

  // Activate this one
  await db
    .update(schemaVersions)
    .set({ status: 'active', approvedByUserId: user.id, approvedAt: new Date() })
    .where(eq(schemaVersions.id, id));

  // Audit log
  await db.insert(auditLog).values({
    userId: user.id,
    action: 'schema_version.approved',
    entityType: 'schema_versions',
    entityId: id,
  });

  // Re-queue the rubric file for full import through the single-file pipeline
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, body.fileId),
  });
  if (file) {
    await inngest.send({
      name: 'csv/single.uploaded',
      data: { uploadedFileId: file.id, storageKey: file.storageKey, schemaVersionId: id },
    });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test, verify it passes**

Note: the `csv/single.uploaded` event has no handler yet — it will be a no-op until Plan 2's import pipeline is built. That's intentional; approving the schema is the deliverable of Plan 1.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat(api): add schema version approval endpoint"
git push
```

---

## Task 21: Integration test — full rubric flow

**Files:**
- Create: `tests/integration/rubric-flow.test.ts`

- [ ] **Step 1: Create the test**

This test runs the pure `processRubricUpload` against real DB (a Neon branch) and the real sample file. It skips R2 by mocking `downloadFromR2`.

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import 'dotenv/config';

vi.mock('@/lib/storage/r2', async () => {
  const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  return {
    downloadFromR2: vi.fn().mockResolvedValue(buf),
    uploadToR2: vi.fn().mockResolvedValue('mocked-key'),
  };
});

import { db } from '@/db/client';
import { uploadBatches, uploadedFiles, schemaVersions } from '@/db/schema';
import { processRubricUpload } from '@/inngest/functions/rubric';
import { eq } from 'drizzle-orm';

describe('rubric flow (integration)', () => {
  let batchId: string;
  let fileId: string;

  beforeAll(async () => {
    const [batch] = await db
      .insert(uploadBatches)
      .values({
        batchType: 'single_csv',
        status: 'validating',
        totalFiles: 1,
        createdByUserId: '00000000-0000-0000-0000-000000000000', // will fail FK unless a user exists
      })
      .returning()
      .catch(async () => {
        // Fallback: create a test user first
        const [user] = await db
          .insert((await import('@/db/schema')).users)
          .values({ clerkUserId: 'test_user', email: 'itest@example.com' })
          .returning();
        return db
          .insert(uploadBatches)
          .values({
            batchType: 'single_csv',
            status: 'validating',
            totalFiles: 1,
            createdByUserId: user.id,
          })
          .returning();
      });
    batchId = batch.id;
    const [file] = await db
      .insert(uploadedFiles)
      .values({
        batchId,
        storageKey: 'test/fake.csv',
        originalFilename: 'valid-sample.csv',
        fileChecksum: 'abc123',
        validationStatus: 'pending',
      })
      .returning();
    fileId = file.id;
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
  });

  it('processes the real sample and creates a draft schema version', async () => {
    const result = await processRubricUpload({
      uploadedFileId: fileId,
      storageKey: 'test/fake.csv',
    });
    expect(result.schemaVersionId).toBeTruthy();

    const version = await db.query.schemaVersions.findFirst({
      where: eq(schemaVersions.id, result.schemaVersionId),
    });
    expect(version?.status).toBe('draft');
    expect(version?.headerHash).toBeTruthy();

    // Clean up the created version
    await db.delete(schemaVersions).where(eq(schemaVersions.id, result.schemaVersionId));
  });
});
```

- [ ] **Step 2: Gate integration tests behind an env flag**

Update `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      ...(process.env.RUN_INTEGRATION ? [] : ['tests/integration/**']),
    ],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
});
```

- [ ] **Step 3: Add script to run integration tests**

```json
{
  "scripts": {
    "test:integration": "RUN_INTEGRATION=1 vitest run tests/integration"
  }
}
```

On Windows PowerShell, use `cross-env`:
```bash
pnpm add -D cross-env
```

And change the script to:
```json
{
  "scripts": {
    "test:integration": "cross-env RUN_INTEGRATION=1 vitest run tests/integration"
  }
}
```

- [ ] **Step 4: Run integration test against your dev Neon branch**

```bash
pnpm test:integration
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "test: add rubric flow integration test"
git push
```

---

## Task 22: Deploy to Vercel

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Install Vercel CLI (optional but useful)**

```bash
pnpm add -D vercel
```

- [ ] **Step 2: Create `vercel.json`**

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install"
}
```

- [ ] **Step 3: Create Vercel project**

Option A — Via dashboard (recommended):
- Go to vercel.com → Add New → Project → Import GitHub repo `raw5045/AmazonAnalytics`
- Framework preset: Next.js (auto-detected)
- Before clicking Deploy, add all env vars from `.env.local` under Environment Variables. Set `APP_PUBLIC_URL` and `NEXT_PUBLIC_APP_URL` to your Vercel URL (you can set once deployed, then redeploy).
- Click Deploy

Option B — Via CLI:
```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest --prod
```

- [ ] **Step 4: Register production Clerk webhook**

In Clerk dashboard → Webhooks → Add Endpoint:
- URL: `https://<your-vercel-app>.vercel.app/api/webhooks/clerk`
- Events: `user.created`, `user.updated`, `user.deleted`
- Copy signing secret into Vercel env vars as `CLERK_WEBHOOK_SIGNING_SECRET`
- Redeploy

- [ ] **Step 5: Deploy Inngest to production**

Go to inngest.com → create app → connect to your Vercel deployment URL `https://<your-vercel-app>.vercel.app/api/inngest`. Copy `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` into Vercel env vars. Redeploy.

- [ ] **Step 6: Bootstrap first admin**

Sign up on the deployed site with the email you want to be admin. Then from your local machine:

```bash
INITIAL_ADMIN_EMAIL=you@example.com pnpm admin:promote
```

(Or set the env var in `.env.local` and just run `pnpm admin:promote`.)

- [ ] **Step 7: Smoke test the deployment**

- Visit `/admin` signed in as admin → should load
- Visit `/admin/rubric` → upload the sample CSV
- Check Inngest dashboard → `rubric-uploaded` function ran
- Go back to the rubric detail page → schema version appears as draft
- Click "Approve as active schema" → status changes to active in DB

- [ ] **Step 8: Commit any last config changes**

```bash
git add .
git commit -m "chore(deploy): add vercel.json"
git push
```

---

## Task 23: Documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Amazon SFR Analytics

Weekly Amazon Search Frequency Rank (SFR) analytics. Admin uploads CSV reports from Seller Central; users analyze keyword trends.

## Status

Phase 0 (Foundation) — rubric upload and schema approval.

## Architecture

See `docs/superpowers/specs/2026-04-15-amazon-sfr-analytics-design.md`.

## Local development

Prereqs: Node 20+, pnpm, Neon account, Clerk account, Cloudflare R2 bucket.

1. `cp .env.example .env.local` and fill values
2. `pnpm install`
3. `pnpm db:migrate`
4. `pnpm db:seed`
5. Terminal A: `pnpm dev`
6. Terminal B: `pnpm inngest:dev`
7. Sign up at http://localhost:3000/sign-up
8. Promote yourself to admin: `pnpm admin:promote` (requires `INITIAL_ADMIN_EMAIL` in `.env.local`)

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm inngest:dev` | Inngest local dev server |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Integration tests (requires DB) |
| `pnpm typecheck` | TypeScript |
| `pnpm db:generate` | Generate migrations from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Seed app_settings |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm admin:promote` | Promote INITIAL_ADMIN_EMAIL to admin |

## Deployment

Vercel (auto-deploys on push to `main`). Env vars must be configured in Vercel dashboard. Clerk webhook URL must point at the deployed `/api/webhooks/clerk`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
git push
```

---

## Acceptance criteria for Plan 1

Plan 1 is done when all of these are true:

- [ ] App is deployed on Vercel at a public URL
- [ ] You can sign up at `/sign-up` and sign in at `/sign-in`
- [ ] Your `users` row is created automatically via the Clerk webhook
- [ ] After running `pnpm admin:promote`, your user has `role = admin`
- [ ] Visiting `/admin` as a standard user redirects to `/app`
- [ ] At `/admin/rubric` you can upload the sample CSV
- [ ] Within a few seconds of upload, the rubric detail page shows a draft schema version with 21 columns detected and the week end date populated
- [ ] Clicking "Approve as active schema" transitions the schema version to `active` and writes an `audit_log` row
- [ ] Unit tests pass: `pnpm test`
- [ ] Integration test passes: `pnpm test:integration`
- [ ] Typecheck passes: `pnpm typecheck`

## What Plan 1 intentionally does NOT deliver

- Actual import of data from the approved file into an analytics table (that's Plan 2)
- ZIP batch upload
- Keyword explorer, detail page, or any analytics
- Watchlists, alerts, email
- User settings page

These are covered in Plans 2, 3, and 4.
