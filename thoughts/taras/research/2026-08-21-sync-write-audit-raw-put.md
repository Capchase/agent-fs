---
date: 2026-08-21
researcher: Claude
topic: "Synchronous / event-loop-blocking work on the PUT /raw write path"
repo: agent-fs
commit: 406e3e2 (v0.13.1, main)
tags: [performance, event-loop, sqlite, fts5, fly.io, health-checks]
status: complete
---

# Sync-write audit: `PUT /.../<path>/raw`

Audit target: the customer report of 23 restarts in 7 days with no OOM, one
`PUT .../gate1-row1-cold-landing.png/raw 200 70661ms SLOW` and one
`event-loop was blocked for ~70.1s (rss=351MB)`.

All references are `path:line` at commit `406e3e2` unless the text says
"at v0.13.0".

## Summary

Yes, the 70 s stall is explained by the v0.13.1 fix, and the code confirms the
commit message rather than merely repeating it. At v0.13.0 a binary `PUT /raw`
of a `.png` reached `clearSearchData`, which ran `DELETE FROM files_fts WHERE
path = ? AND drive_id = ?` against an internal-content FTS5 table. FTS5 can only
use `MATCH` and `rowid`, so that statement scanned the entire index, and
`bun:sqlite` runs it synchronously on the event loop. The same call path then
queried `content_chunks` by `(file_path, drive_id)` with no index, a second full
scan of a table that holds a copy of every indexed file. Both costs scale with
the whole search index, not with the 70 KB PNG. v0.13.1 fixes both: writers now
touch `files_fts_docs`, which has a unique `(drive_id, path)` index, and
`idx_content_chunks_drive_path` was added.

What still blocks the loop at HEAD is smaller but real. The FTS5 `crisismerge`
setting is deliberately restored to the default 16 after the migration, so a
text write still pays a whole-level merge every 16th commit at a level, which the
repo's own comment describes as "many seconds" at GB scale. The request body is
fully buffered with no streaming, SHA-256 runs synchronously over the whole
buffer (twice on the local-filesystem backend), and unknown-extension text files
get a per-byte JavaScript scan. Nothing sets `PRAGMA synchronous` or
`wal_autocheckpoint`, so each of the 3 to 5 commits per write fsyncs and can drag
in a synchronous WAL checkpoint.

The biggest live risk is not a request at all. `idx_content_chunks_drive_path`
is created inside `createDatabase()`, which runs before `Bun.serve`, so the
first boot of 0.13.1 on a large database serves no `/health` while the index
builds. `DEPLOYMENT.md` budgets "several minutes on a `shared-cpu-1x` Fly
machine". `fly.toml` grants a 10 s grace period. That combination can restart-loop
the very upgrade that fixes the problem.

`/health` shares the loop. It is one `app.get("/health", ...)` on the single
`Bun.serve` instance, with no worker thread, no separate listener, and no DB
query. When a synchronous statement holds the loop, `/health` is not slow, it is
absent. LiteFS is not involved: `litefs.yml` is entirely commented out and the
`Dockerfile` `CMD` does not use it.

## Request sequence for `PUT /raw`

Cost labels: **SYNC-BLOCKING** holds the loop, **ASYNC-IO** yields, **CPU** holds
the loop while computing.

| # | Step | Ref | Class | Cost |
|---|---|---|---|---|
| 1 | `Bun.serve` accepts the socket. One listener, one loop, no workers. | `packages/server/src/index.ts:60` | ASYNC-IO | O(1) |
| 2 | CORS middleware. | `packages/server/src/app.ts:24` | SYNC-BLOCKING | O(1) |
| 3 | Request log start line `--> #N PUT ...`. | `packages/server/src/middleware/request-log.ts:21` | SYNC-BLOCKING | O(1) |
| 4 | `bodyLimit({ maxSize: 50 MB })`. | `packages/server/src/app.ts:32` | SYNC-BLOCKING | O(1) |
| 5 | Auth: SHA-256 of the bearer via `Bun.CryptoHasher`, then `SELECT ... WHERE api_key_hash = ?`. `users` has no index on that column. | `packages/server/src/middleware/auth.ts:29`, `packages/core/src/identity/users.ts:7`, `packages/core/src/identity/users.ts:59` | SYNC-BLOCKING | O(#users) |
| 6 | Rate limit (in-memory). | `packages/server/src/app.ts:38` | SYNC-BLOCKING | O(1) |
| 7 | Route match. | `packages/server/src/routes/files.ts:105` | SYNC-BLOCKING | O(1) |
| 8 | Reject `application/json` bodies. | `packages/server/src/routes/files.ts:112` | SYNC-BLOCKING | O(1) |
| 9 | `resolveContext`: drive read plus role read, both point lookups. | `packages/server/src/routes/files.ts:124`, `packages/core/src/identity/context.ts:14` | SYNC-BLOCKING | O(log n) |
| 10 | Path extract, decode, normalize. | `packages/server/src/routes/files.ts:130` | CPU | O(path length) |
| 11 | `If-Match` / `If-None-Match` parse. | `packages/server/src/routes/files.ts:143` | SYNC-BLOCKING | O(1) |
| 12 | `await c.req.arrayBuffer()` then `new Uint8Array(...)`. Whole body in memory. No streaming. | `packages/server/src/routes/files.ts:167` | ASYNC-IO then CPU | O(file size) |
| 13 | `writeRaw` entry, `requireDriveRole` editor check. | `packages/core/src/ops/write.ts:43`, `:47` | SYNC-BLOCKING | O(log n) |
| 14 | 50 MB size cap. | `packages/core/src/ops/write.ts:65` | SYNC-BLOCKING | O(1) |
| 15 | `createHash("sha256").update(bytes).digest("hex")` over the full buffer, `node:crypto`, not chunked. | `packages/core/src/ops/write.ts:75` | CPU | O(file size) |
| 16 | Conditional writes only: `assertExpectedVersion` (`MAX(version)` on the unique index) then `getHeadContentHash`. Dedup returns here on an identical rewrite. | `packages/core/src/ops/write.ts:81`, `:92`, `packages/core/src/ops/versioning.ts:23`, `:123` | SYNC-BLOCKING | O(log n) |
| 17 | `detectMimeType` by extension. `.png` maps to `image/png`. | `packages/core/src/ops/write.ts:106`, `packages/core/src/ops/mime.ts:56` | SYNC-BLOCKING | O(1) |
| 18a | S3/MinIO backend: one `PutObjectCommand` with the whole buffer. | `packages/core/src/s3/client.ts:67` | ASYNC-IO | O(file size) |
| 18b | Local-FS backend: a **second** full SHA-256, an `exists()`, then **two** full-size uploads (content-addressed blob, then plain key). | `packages/core/src/storage/local-adapter.ts:110`, `:116`, `:117`, `:121` | CPU + ASYNC-IO | O(file size) hashed twice, written twice |
| 19 | `createVersion`: `getNextVersion` again, then one sync `db.transaction` with a `file_versions` insert and a `files` upsert. One fsync at commit. | `packages/core/src/ops/write.ts:110`, `packages/core/src/ops/versioning.ts:166`, `:172` | SYNC-BLOCKING | O(log n) + 1 fsync |
| 20 | `indexBytesForSearch`: `decodeUtf8Strict` runs a strict `TextDecoder` over the whole buffer. Returns `null` for a PNG. | `packages/core/src/ops/write.ts:124`, `packages/core/src/ops/search-index.ts:71`, `packages/core/src/ops/mime.ts:96` | CPU | O(file size) |
| 20a | Unknown-extension branch only: `looksLikeTextBytes` iterates every byte in JavaScript. | `packages/core/src/ops/mime.ts:121` | CPU | O(file size) |
| 21 | Binary branch: `clearSearchData`. `removeFromIndex` deletes from `files_fts_docs` by `(drive_id, path)`. **HEAD:** unique index, O(log n). **v0.13.0:** full FTS5 scan, O(index size). | `packages/core/src/ops/search-index.ts:10`, `packages/core/src/search/fts.ts:31`, `packages/core/src/db/raw.ts:143` | SYNC-BLOCKING | see cells |
| 22 | `clearSearchData` continued: `content_chunks` select by `(file_path, drive_id)`. **HEAD:** `idx_content_chunks_drive_path`, O(log n). **v0.13.0:** full scan of the chunk table. | `packages/core/src/ops/search-index.ts:12`, `packages/core/src/db/raw.ts:129` | SYNC-BLOCKING | see cells |
| 23 | `clearSearchData` continued: per-chunk `DELETE FROM chunk_vectors`, then a `content_chunks` delete, then `UPDATE files SET embedding_status = NULL`. | `packages/core/src/ops/search-index.ts:26`, `:29`, `:40` | SYNC-BLOCKING | O(chunks for this file) |
| 24 | Text branch only: `indexFile` writes `files_fts_docs` inside a transaction. Triggers tokenize into `files_fts`. Can trip an FTS5 crisis merge. | `packages/core/src/search/fts.ts:14`, `packages/core/src/db/raw.ts:178` | SYNC-BLOCKING | O(content size) + O(level size) on merge |
| 25 | Text branch only: `scheduleEmbedding` writes `embedding_status = 'pending'` synchronously and queues the job on the same loop, semaphore 2. | `packages/core/src/search/pipeline.ts:149` | SYNC-BLOCKING then deferred | O(log n) now, O(content size) later |
| 26 | JSON response with `ETag`, `X-Agent-FS-Version`, `X-Agent-FS-Content-Hash`. | `packages/server/src/routes/files.ts:187` | SYNC-BLOCKING | O(1) |
| 27 | Request log completion line. `SLOW` is appended at >= 2000 ms. | `packages/server/src/middleware/request-log.ts:27` | SYNC-BLOCKING | O(1) |

The PNG in the customer log takes steps 1 to 23, skipping 16 (no conditional
header is required), 20a, 24 and 25.

## Root-cause candidates, ranked

### RC-1. FTS5 delete-by-path scanned the whole index on every write

**Status at v0.13.1: FIXED. Confidence: high.**

At v0.13.0 (`git diff v0.13.0 v0.13.1 -- packages/core/src/search/fts.ts`):

```
-  // Remove existing entry first (upsert pattern for FTS5)
-  raw
-    .prepare("DELETE FROM files_fts WHERE path = ? AND drive_id = ?")
-    .run(params.path, params.driveId);
```

At HEAD, `packages/core/src/search/fts.ts:31-39`:

```ts
export function removeFromIndex(
  db: DB,
  params: { path: string; driveId: string }
): void {
  const raw = getRawDb(db);
  raw
    .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path = ?")
    .run(params.driveId, params.path);
}
```

`files_fts_docs` carries `files_fts_docs_drive_path_uq` (`packages/core/src/db/raw.ts:143-144`).

Cost model: at v0.13.0 the delete is O(total index size) per write, regardless of
the file being written, because FTS5 cannot use an equality constraint on a
column. It runs even when no row matches, which is exactly the first-upload PNG
case. At HEAD it is O(log n). This is the single statement that explains a 70 s
block on a 70 KB PNG.

### RC-2. `content_chunks` lookup had no `(drive_id, file_path)` index

**Status at v0.13.1: FIXED, but only by a boot-time index build. Confidence: high.**

`packages/core/src/ops/search-index.ts:9-21` is unchanged by 0.13.1:

```ts
export function clearSearchData(ctx: OpContext, path: string): void {
  removeFromIndex(ctx.db, { path, driveId: ctx.driveId });

  const oldChunks = ctx.db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, path),
        eq(schema.contentChunks.driveId, ctx.driveId)
      )
    )
    .all();
```

The fix is the new index at `packages/core/src/db/raw.ts:126-130`:

```sql
-- Every write, rm, mv and the embedding job look chunks up by (drive, path).
-- Without this index each of those is a full scan of a table that holds a
-- copy of every indexed file.
CREATE INDEX IF NOT EXISTS idx_content_chunks_drive_path
  ON content_chunks(drive_id, file_path);
```

Cost model: O(chunk-table size) per write before, O(log n) after. Because the
fix lives in the code path, not in the query, the benefit only lands once the
index actually exists. See RC-3 for what building it costs.

### RC-3. The 0.13.1 upgrade itself blocks `/health` before the listener opens

**Status at v0.13.1: NEW IN 0.13.1. Confidence: high.**

`CREATE_TABLES_SQL` runs inside `createDatabase()`, and `createDatabase()` runs
before `Bun.serve`:

`packages/core/src/db/index.ts:36-52`

```ts
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");

  // Create all tables (idempotent)
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VEC_TABLE_SQL);
```

`packages/server/src/index.ts:19-26` then `:60-64`

```ts
const db = createDatabase();
const sqlite = (db as any).$client as Database;
const ftsMigrationPending = prepareFtsMigration(sqlite);
...
const server = Bun.serve({ fetch: app.fetch, port: ..., hostname: ... });
```

The repo already documents the cost (`DEPLOYMENT.md`, added in this same commit):

> **At startup, before listening:** one new index on `content_chunks` is built.
> This reads the table once. Budget roughly 10-20 s per GB of database on a
> laptop, several minutes on a `shared-cpu-1x` Fly machine. `/health` is not
> served during this step.

Cost model: O(chunk-table size), once, synchronously, with no listener. `fly.toml`
allows a 10 s grace period. If the platform kills the machine mid-build, SQLite
rolls the index back and the next boot restarts it from zero, so this can loop
(inferred from the fact that the statement is a single non-resumable DDL). This
is the sharpest operational risk in the upgrade.

### RC-4. FTS5 crisis merges at the default `crisismerge = 16`

**Status at v0.13.1: STILL PRESENT for text writes. Confidence: medium-high.**

`packages/core/src/db/fts-migration.ts:41-47`

```ts
// FTS5 writes one b-tree segment per committed batch. With the default
// crisismerge of 16, every 16th commit at a level merges that whole level at
// once, which at GB scale blocks for many seconds. Raising it for the copy
// leaves the merging to the incremental automerge (bounded work per commit);
// it is restored afterwards. Well below FTS5's hard 2000-segment limit.
const COPY_CRISISMERGE = 1000;
const DEFAULT_CRISISMERGE = 16;
```

`packages/core/src/db/fts-migration.ts:139-142` restores it:

```ts
  sqlite.transaction(() => {
    setCrisismerge(sqlite, DEFAULT_CRISISMERGE);
    sqlite.prepare("DELETE FROM meta WHERE key = ?").run(TUNING_KEY);
  })();
```

Cost model: amortized O(1) per write, with a spike of O(level size) on roughly
every 16th commit at a level. The repo's own words are "many seconds" at GB
scale. This applies to `indexFile` (text writes) and to a `files_fts_docs` delete
that matches a row, because the `AFTER DELETE` trigger pushes an FTS5 `'delete'`
command (`packages/core/src/db/raw.ts:183-186`). A first-time PNG upload matches
no row and pays nothing.

### RC-5. Whole-body buffering, synchronous SHA-256, double hash and double write

**Status at v0.13.1: STILL PRESENT. Confidence: high.**

`packages/server/src/routes/files.ts:103-104` states the design:

> The body is buffered up to Hono's 50 MB body limit, no true streaming in v1.

`packages/core/src/ops/write.ts:73-77`

```ts
  // Compute SHA-256 once. Used for both dedup short-circuit and the
  // persisted content_hash on the version row.
  const contentHash = createHash("sha256")
    .update(bytes)
    .digest("hex");
```

The "once" holds for the S3 backend only. The local-FS backend hashes again and
writes the bytes twice, `packages/core/src/storage/local-adapter.ts:110-121`:

```ts
    const hash = createHash("sha256").update(bytes).digest("hex");
    const bk = blobKey(hash);
    if (!(await this.files.exists(bk))) {
      await this.files.upload(bk, bytes);
    }
    await this.files.upload(key, bytes, contentType ? { contentType } : undefined);
```

Cost model: O(file size) memory plus one or two O(file size) CPU hashes, plus
one or two O(file size) writes. At 70 KB this is sub-millisecond and cannot
explain the report. At the 50 MB ceiling it is a few hundred milliseconds of
blocked loop and 100 MB of disk writes on the local backend.

### RC-6. Per-byte JavaScript text sniff on unknown extensions

**Status at v0.13.1: STILL PRESENT. Confidence: high on the code, medium on customer exposure.**

`packages/core/src/ops/mime.ts:121-132`

```ts
function looksLikeTextBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;

  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    const allowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControl) suspicious++;
  }

  return suspicious / bytes.length < 0.01;
}
```

Cost model: O(file size) with a JavaScript-level loop, reached only when the
extension is unknown (`application/octet-stream`) and the bytes already decoded
as strict UTF-8 (`packages/core/src/ops/mime.ts:114`). A 50 MB extensionless log
file costs a full strict decode plus 50 million loop iterations, then full FTS5
tokenization of the decoded string. A `.png` short-circuits at the decode.

### RC-7. No `PRAGMA synchronous`, 3 to 5 fsyncs per write

**Status at v0.13.1: STILL PRESENT. Confidence: high on the code, low that it explains 70 s.**

`packages/core/src/db/index.ts:36-37` sets only two pragmas:

```ts
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
```

A grep across `packages/*/src` finds no `busy_timeout`, no `synchronous`, no
`wal_autocheckpoint`, no `mmap_size`, no `cache_size`, and no `BEGIN IMMEDIATE`.
In WAL mode SQLite defaults to `synchronous = FULL`, so every commit fsyncs the
WAL. One binary PUT commits at least four times: three autocommit statements
inside `clearSearchData` (`packages/core/src/ops/search-index.ts:10`, `:29`,
`:40`) and one `createVersion` transaction
(`packages/core/src/ops/versioning.ts:172`). Cost model: O(1) per commit but
each fsync is a synchronous syscall on the loop, milliseconds on a Fly volume.

### RC-8. WAL auto-checkpoint runs synchronously in the writing connection

**Status at v0.13.1: STILL PRESENT. Confidence: medium.**

Nothing sets `wal_autocheckpoint`, so SQLite uses the 1000-page default and the
committing connection performs the checkpoint inline. FTS5 merges write large
page volumes, so checkpoints on this workload are not small. Cost model:
O(WAL size) of synchronous I/O, charged to whichever write happens to cross the
threshold. Not measured here.

### RC-9. In-process local embedding model on text writes

**Status at v0.13.1: STILL PRESENT for text writes. Confidence: medium.**

The default embedding provider is `local` (`packages/core/src/config.ts:104-108`),
and the daemon builds it at `packages/server/src/index.ts:51`. `local` resolves
to a `nomic-embed-text-v1.5` GGUF loaded through `node-llama-cpp` in this
process (`packages/core/src/search/embeddings/local.ts:7`, `:27-41`). Chunk and
vector inserts run one statement per chunk on the loop
(`packages/core/src/search/pipeline.ts:106-122`). The job is deferred off the
request (`packages/core/src/search/pipeline.ts:167`) but not off the loop, and
the semaphore only caps it at 2 concurrent.

Cost model: O(chunks) native inference plus O(chunks) synchronous inserts, per
text write. I cannot confirm from the repo whether the native addon releases the
loop during inference, nor whether it loads at all in the slim image, so this
stays medium confidence. It does not apply to the reported PNG.

### RC-10. No `busy_timeout` set anywhere

**Status at v0.13.1: STILL PRESENT. Confidence: high.**

The brief asks about a `busy_timeout` spin blocking the loop. That hazard does
not exist here, because no `busy_timeout` is ever set. The inverse hazard does:
SQLite's default is 0, so a second process opening the same file (the CLI in
embedded mode against `AGENT_FS_HOME`) gets an immediate `SQLITE_BUSY` throw
rather than a wait. Cost model: not a latency issue, a correctness issue.

### RC-11. LiteFS is not in the deployment path

**Status: not applicable. Confidence: high.**

`litefs.yml` at the repo root is entirely commented out and says so:

> This is an OPTIONAL upgrade path for SQLite replication. By default, agent-fs
> uses a simple volume mount (/data). Only use LiteFS if you need multi-node read
> replication. To enable: install litefs in Dockerfile, change CMD to use litefs
> as the entrypoint.

`Dockerfile:43` runs `CMD ["bun", "run", "packages/cli/dist/cli.js", "server"]`,
with no LiteFS anywhere in the image. `fly.toml` mounts `agent_fs_data` at
`/data` directly. FUSE-mediated write latency is therefore ruled out, unless the
customer built a custom image.

### RC-12. `users.api_key_hash` is unindexed, so auth scans on every request

**Status at v0.13.1: STILL PRESENT. Confidence: high, impact low.**

`packages/core/src/db/raw.ts:5-10` declares `users` with a primary key on `id`
and a unique constraint on `email` only. `packages/core/src/identity/users.ts:59`
filters on `api_key_hash`. Cost model: O(#users) per authenticated request. On a
single-tenant install this is a handful of rows. Listed for completeness, not as
a suspect.

## Health endpoint and probe math

`/health` is one line, on the same `Bun.serve` instance, with no DB access:

`packages/server/src/app.ts:46-47`

```ts
  // Health check
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
```

It is exempt from the request log (`packages/server/src/middleware/request-log.ts:17`)
and from auth (`packages/server/src/middleware/auth.ts:6`), and the rate limiter
is scoped to `/orgs/*`, `/auth/*` and `/mcp` only (`packages/server/src/app.ts:38-40`).
There is exactly one listener, created at `packages/server/src/index.ts:60`, plus
a Unix-socket IPC listener at `:100` on the same loop. No `Worker`, no
`worker_threads`, no second process. So the probe shares the loop with every
synchronous SQLite statement on the write path.

**Fly.io** (`fly.toml`):

```toml
  [[http_service.checks]]
    interval = '30s'
    timeout = '5s'
    grace_period = '10s'
    method = 'GET'
    path = '/health'
```

A 70.1 s block spans two full 30 s intervals and clips a third, so 2 to 3
consecutive probes get no response and each times out after 5 s. `fly.toml`
declares no `[[restart]]` policy, so the machine uses Fly's default. Fly's proxy
stops routing to a machine with failing checks, and 23 restarts over 7 days
(about 3.3 per day) matches a workload that trips a multi-tens-of-seconds stall
a few times daily. The link from failing checks to the restarts is inferred, not
read from this repo.

**Docker Compose / plain Docker** (`Dockerfile:40-41`):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7433/health || exit 1
```

Three consecutive failures at a 30 s interval means roughly 90 s of blocked loop
before Docker flips the container to `unhealthy`. A 70 s block sits right at the
edge: it produces 2 to 3 failures depending on phase. `docker-compose.hosted.yml`
adds no healthcheck override and no `restart:` policy, and Docker alone does not
restart on `unhealthy`, so a restart there implies an orchestrator or an autoheal
sidecar. Inferred.

The `shared-cpu-1x` VM in `fly.toml` matters: a scan that takes 17 s of blocked
loop on a laptop (the commit's own measurement on a 1.5 GB index) becomes tens of
seconds under a throttled shared vCPU, which is what 70 s looks like.

## The two log lines

Both come from code added on 2026-07-09 in `55818a3 feat(server): request logging
+ event-loop lag watchdog`, so the customer was already running that
instrumentation.

**Loop-lag watchdog**, `packages/server/src/index.ts:80-91`:

```ts
let watchdogLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const stalledMs = now - watchdogLast - 1_000;
  if (stalledMs > 5_000) {
    console.error(
      `event-loop was blocked for ~${(stalledMs / 1000).toFixed(1)}s ` +
        `(rss=${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB)`,
    );
  }
  watchdogLast = now;
}, 1_000).unref();
```

This is genuine loop lag, not request latency. A 1 s timer that fires 71.1 s late
means the loop could not run a callback for 70.1 s. A slow-but-async request
would not delay it. The threshold is 5 s, and the message only prints after the
loop unblocks.

**Slow-request logger**, `packages/server/src/middleware/request-log.ts:25-28`:

```ts
      const ms = Math.round(performance.now() - start);
      const user = c.get("user")?.email ?? "-";
      const slow = ms >= 2000 ? " SLOW" : "";
      console.log(`<-- #${id} ${c.req.method} ${path} ${c.res.status} ${ms}ms user=${user}${slow}`);
```

The `SLOW` threshold is 2000 ms. The customer's `70661ms` for the PUT and the
watchdog's `~70.1s` agree within the watchdog's own 1 s sampling, which pins the
block to that single request rather than to a background job.

## Recent history

```
$ git log --oneline v0.12.0..HEAD -- packages/core/src/db packages/core/src/ops \
    packages/core/src/search packages/server/src
406e3e2 fix: stop full search-index scans on every write (70 s event-loop stalls), migrate to Bun 1.4 (#32)
e710207 fix(server): declare charset=utf-8 on text file downloads (#30)
```

The write path did not change in 0.12.x or 0.13.0. `e710207` only touched
response headers. So the scan behavior in RC-1 and RC-2 was present unchanged
across every version the customer could plausibly be running, back past
v0.12.0 (2026-08-04).

Release dates: v0.13.0 on 2026-08-20 10:04 CEST, v0.13.1 on 2026-08-21 16:08
CEST. The customer's log is dated 2026-08-21. If their log predates 16:08 CEST,
they cannot have been running the fix. Their `.../research/2026-08-21-swa-kanban-v0-verify/...`
path suggests a same-day upload, so the most likely reading is that they hit the
bug on 0.13.0 or earlier, hours before the fix shipped.

## Prior analysis in `thoughts/`

None. `thoughts/taras/research/` has 20 documents, the newest dated 2026-06-25,
and none discusses event-loop stalls, restarts, or the write path's SQLite cost.
A grep for stall-related terms matches only the substring "install". This
document is the first analysis of this incident.

The nearest related documents are `thoughts/taras/research/2026-03-17-flyio-deployment.md`
(the original Fly setup) and `thoughts/taras/plans/2026-06-25-multi-adapter-storage/step-3.md`
(the local-FS adapter's blob-first write ordering, RC-5).

## Ranked fixes for what remains at HEAD

### F-1. Make the boot-time index build not kill the upgrade

**Effect on the 70 s case: unblocks the fix from landing at all. Effort: S. Risk: low.**

Files: `packages/core/src/db/index.ts`, `packages/server/src/index.ts`, `fly.toml`.

Move `CREATE INDEX idx_content_chunks_drive_path` out of `CREATE_TABLES_SQL`'s
boot path and into the same background, batched, resumable slot that
`runFtsMigration` already occupies, or at minimum start `Bun.serve` before the
index build and have the write path tolerate its absence. The cheapest immediate
mitigation needs no code: raise `grace_period` in `fly.toml` to cover the
documented worst case (say `600s`) for the upgrade deploy, then lower it again.
Note that a raised grace period also delays detection of a genuinely dead boot.

### F-2. Keep `crisismerge` raised in steady state, or move merges off the write

**Effect on the 70 s case: removes the largest remaining multi-second spike on text writes. Effort: S. Risk: medium.**

Files: `packages/core/src/db/fts-migration.ts`, `packages/core/src/db/index.ts`.

`DEFAULT_CRISISMERGE = 16` is restored after the copy and then governs every
subsequent write. Setting a higher steady-state `crisismerge` (the migration path
already proves 1000 is workable) converts whole-level merges into bounded
incremental automerge work. The risk is segment accumulation and slower `MATCH`
queries between merges, and FTS5's hard 2000-segment limit. Pair it with an
explicit `INSERT INTO files_fts(files_fts, rank) VALUES('merge', N)` run from a
timer, so merging is scheduled rather than charged to a random user's write.
Measure query latency before and after.

### F-3. Move search indexing off the request path onto a queue

**Effect on the 70 s case: makes write latency independent of index size permanently. Effort: M. Risk: medium.**

Files: `packages/core/src/ops/write.ts`, `packages/core/src/ops/search-index.ts`,
`packages/core/src/search/pipeline.ts`, plus a small durable queue table.

Today `indexBytesForSearch` runs inline at `packages/core/src/ops/write.ts:124`,
before the response. Writing an `index_jobs` row inside the `createVersion`
transaction and draining it from a timer with an explicit yield between items
gives the write path a bounded cost and gives every future indexing regression a
single place to be throttled. `scheduleEmbedding` already models the deferred
half of this; the FTS half is what is missing. Search results become eventually
consistent, which is the real cost and needs a product decision.

### F-4. Set the missing SQLite pragmas

**Effect on the 70 s case: none directly, removes several milliseconds of fsync per write and caps checkpoint spikes. Effort: S. Risk: low.**

Files: `packages/core/src/db/index.ts`, `packages/core/src/test-utils.ts`.

Add `PRAGMA synchronous = NORMAL` (safe under WAL: a process crash loses
nothing, only a host power loss can lose recent commits), `PRAGMA busy_timeout`
with a short value such as 250 ms so a second connection retries instead of
throwing, and an explicit `PRAGMA wal_autocheckpoint` tuned low enough that no
single checkpoint is large. Keep the two files in sync so tests exercise the same
configuration.

### F-5. Stream the body and hash incrementally

**Effect on the 70 s case: none, matters at the 50 MB ceiling. Effort: M. Risk: medium.**

Files: `packages/server/src/routes/files.ts`, `packages/core/src/ops/write.ts`,
`packages/core/src/storage/local-adapter.ts`, `packages/core/src/s3/client.ts`.

Replace `await c.req.arrayBuffer()` (`packages/server/src/routes/files.ts:167`)
with a streamed read, hash with `Bun.CryptoHasher` fed per chunk, and pass the
stream to the adapter. The local adapter should accept the hash from the caller
instead of recomputing it (`packages/core/src/storage/local-adapter.ts:110`) and
should write the blob then hard-link or copy at the filesystem level rather than
uploading the same bytes twice (`:117` and `:121`). The blocker is that
`assertExpectedVersion`'s dedup short-circuit needs the hash before the write, so
streaming means either a two-pass read or accepting a client-supplied
`Content-Digest`.

### F-6. Skip the text sniff for large or known-binary payloads

**Effect on the 70 s case: none, removes a multi-second CPU loop on large extensionless uploads. Effort: S. Risk: low.**

Files: `packages/core/src/ops/mime.ts`.

`looksLikeTextBytes` (`packages/core/src/ops/mime.ts:121`) should sample a
bounded prefix, for example the first 64 KB, instead of every byte, and
`decodeIndexableText` should refuse to index above a size threshold well under
the 50 MB cap. A MIME allowlist check before the strict decode
(`packages/core/src/ops/mime.ts:108`) would also stop a 50 MB PNG from being
fully UTF-8-decoded just to learn it is binary.

### F-7. Give `/health` its own listener or a worker

**Effect on the 70 s case: stops the restarts without fixing the stall. Effort: M. Risk: medium.**

Files: `packages/server/src/index.ts`, `packages/server/src/app.ts`, `fly.toml`,
`Dockerfile`.

A second `Bun.serve` on a different port does not help, because it shares the
loop. Only a `Worker` (or a tiny sidecar process) that answers the probe
independently would keep the machine alive through a block. Be honest about the
tradeoff: this makes the probe lie. A daemon that cannot answer a request for
70 s is broken, and hiding that from the orchestrator removes the only signal
the customer currently has. Recommend it only as a deliberate, documented
decision paired with F-1 through F-3, never on its own.

### F-8. Index `users.api_key_hash`

**Effect on the 70 s case: none. Effort: S. Risk: low.**

Files: `packages/core/src/db/raw.ts`, `packages/core/src/db/migrate.ts`.

One `CREATE INDEX IF NOT EXISTS` plus a matching idempotent migration. Removes a
per-request table scan that will matter if the deployment ever grows past a few
users.

## What to tell the customer now

1. **The stall is understood and fixed in 0.13.1.** Every write, including a
   binary PNG upload, ran two full scans of the search index to locate one row.
   The cost scaled with the whole index, not with the uploaded file. Both scans
   are now index lookups. Point them at `DEPLOYMENT.md`'s
   "Upgrading to 0.13.1: search index migration" section.

2. **Ask which version they run before promising anything.** `GET /health`
   returns `{ ok, version }` (`packages/server/src/app.ts:47`). v0.13.1 was
   published on 2026-08-21 at 16:08 CEST, the same day as their log. If they are
   on 0.13.0 or earlier, upgrading is the fix. If they are already on 0.13.1 and
   still stalling, the remaining suspects are RC-4 (FTS5 crisis merges on text
   writes) and RC-9 (in-process embeddings), and we need their logs plus the
   database size.

3. **Warn them about the upgrade boot, clearly.** The first start of 0.13.1
   builds one index before opening the listener. `/health` returns nothing during
   that window. The project's own estimate is several minutes on a
   `shared-cpu-1x` machine. With `grace_period = '10s'` in `fly.toml`, that boot
   can look like a crash loop. Advise them to raise `grace_period` for the
   upgrade deploy, run it off-peak, and watch for the
   `search index migration: starting at legacy rowid N` log line, which confirms
   the daemon reached the listening state.

4. **Set expectations for the background copy.** After the listener opens, old
   index rows copy in 512 KB batches with a yield after each
   (`packages/core/src/db/fts-migration.ts:229-231`), resumable across restarts
   via a cursor in `meta`. Search stays complete during the copy because both
   layouts are queried. Expect a few multi-second stalls anyway: FTS5 merges, and
   the final `DROP TABLE files_fts_legacy`, which the code itself flags as "a
   single scan of the old index, about what one write used to cost"
   (`packages/core/src/db/fts-migration.ts:243-244`).

5. **Offer two config mitigations that need no new build.** Raise the Fly
   `grace_period` so a stall no longer trips a restart while they upgrade, and,
   if they do not use semantic search, unset `OPENAI_API_KEY` / `GEMINI_API_KEY`
   and set the embedding provider away from `local` so `scheduleEmbedding` never
   fires (`packages/core/src/search/pipeline.ts:154` returns immediately when the
   provider is null). The second one only helps text writes.

6. **Do not tell them the restarts were a probe misconfiguration.** They were
   not. The probe correctly reported a daemon that could not answer for 70 s.

## Open questions

1. Which version is the customer actually running? Everything downstream depends
   on this and `GET /health` answers it in one call.
2. Which storage backend? `fly.toml` sets no S3 variables, so the config file or
   other env decides between `AgentS3Client` and `LocalStorageAdapter`. The local
   adapter hashes twice and writes twice (RC-5). Their `/data` volume is 1 GB
   initial with auto-extend to 10 GB, which suggests local storage.
3. How large is the database and the `content_chunks` table? That sets the RC-3
   boot-time index build cost, which is the number that decides whether the
   upgrade is safe to run in a traffic window.
4. Does `node-llama-cpp` load in the `oven/bun:1.4-slim` image, and does its
   inference call release the event loop? RC-9 stays medium confidence until
   someone measures the loop-lag watchdog during a text write on a real machine.
5. What is the customer's write mix? A PNG-heavy workload is fully explained by
   RC-1 and RC-2. A markdown-heavy workload also carries RC-4 and RC-9, which the
   0.13.1 fix does not address.
6. Does Fly restart a machine on sustained `http_service.checks` failure with no
   `[[restart]]` policy declared, or does it only deregister it from the proxy?
   The 23 restarts are consistent with a restart, but I did not verify Fly's
   behavior against their documentation.
7. Was any 70 s stall observed on a request that was NOT a write? If yes, the
   analysis above is incomplete and the read path needs the same audit.
