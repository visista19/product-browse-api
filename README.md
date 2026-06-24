# Product Browse API — keyset pagination over 200k products

Browse ~200,000 products **newest-first**, **filter by category**, and **paginate fast at any depth** — while staying correct as data changes (no product seen twice, none missed).

- **Backend:** Node.js + Express + `pg` (PostgreSQL)
- **DB:** PostgreSQL (Supabase free tier)
- **Frontend:** React (Vite)
- **Hosting:** Render free tier (backend web service + static frontend)

```
db/        schema.sql + seed.js (200k via generate_series) + verify.js
backend/   Express API: GET /products (keyset), POST /admin/seed-batch
frontend/  Vite + React UI: category filter, "Load more", consistency demo
render.yaml  Blueprint for both Render services
```

---

## Why this design

### Keyset (cursor) pagination, not OFFSET/LIMIT

| | `OFFSET N LIMIT k` | Keyset (this project) |
|---|---|---|
| Cost at page _p_ | scans & discards `N` rows → O(offset) | index **seek** → O(log n), same at any depth |
| Under concurrent inserts | list shifts → **duplicates / skips** | cursor anchors to a value → **stable** |

`OFFSET` is *position-based*: insert 50 rows at the top and every page shifts down, so a reader re-sees rows or skips them — exactly what the requirement forbids. Keyset remembers the **value** of the last row seen (`(created_at, id)`) and asks for rows strictly after it, so inserts above the cursor never disturb the window.

### Order by `created_at DESC, id DESC` — and why `created_at`, not `updated_at`

`created_at` is **immutable**. Newly created products are born at the top of the feed, *above* any reader's cursor, so a downward-paging reader can never collide with them — the **no-duplicate / no-miss** guarantee holds for free, even while other rows are being UPDATED.

If we ordered by mutable `updated_at`, a row a reader hasn't reached yet could be updated, jump above the cursor, and be **missed**. Keyset alone can't prevent that because the row's sort position moves mid-scan; you'd need a pinned snapshot timestamp. Since "newest first" means newest *created*, `created_at DESC` is both correct and free of that problem.

`id` is a **mandatory** tiebreaker: many rows share the same `created_at`, so `created_at` alone is not unique and the cursor would be ambiguous. The tuple `(created_at, id)` is globally unique and stable.

### Two indexes — and why `category` comes first

```sql
CREATE INDEX idx_products_feed     ON products (created_at DESC, id DESC);
CREATE INDEX idx_products_cat_feed ON products (category, created_at DESC, id DESC);
```

Rule: **equality-filter columns first, then range/sort columns.** For `WHERE category = $1 AND (created_at,id) < (...)`, `category` must be the leading column so Postgres can seek straight to that category's slice and walk it in feed order. An index of `(created_at, id, category)` could *not* seek on `category` (it's buried last) and would scan-then-filter.

### Seeding without a loop

`db/seed.js` issues **one** server-side `INSERT ... SELECT FROM generate_series(1,200000)`. Postgres builds all 200k rows internally in a single round-trip (a few seconds) — no per-row INSERTs, no network chatter.

Two non-obvious correctness details the seed handles (both are the "many rows share column values" edge cases):

- **Per-row timestamps via an optimizer fence.** A volatile `random()`/`now()` in an *uncorrelated* subquery can be evaluated once for the whole statement, giving every row the *same* `created_at`. The generator wraps the row expression in a subquery with `OFFSET 0` (a planner fence) so `random()` runs once per row.
- **Millisecond precision (`timestamptz(3)`).** JavaScript `Date` only holds milliseconds; a `timestamptz` storing microseconds would make a cursor built from a JS `Date` truncate and miss boundary rows. Pinning the columns to ms makes the cursor round-trip lossless. The keyset predicate also casts params explicitly: `(created_at, id) < ($1::timestamptz, $2::bigint)`.

---

## API

`GET /products?category=<opt>&cursor=<opt>&limit=<1..100, default 20>`

```json
{
  "data": [ { "id": "200000", "name": "...", "category": "books",
              "price": "123.45", "created_at": "...", "updated_at": "..." } ],
  "nextCursor": "eyJ0cyI6...",   // opaque; pass back to get the next page
  "hasMore": true
}
```

- First page: omit `cursor`. Next page: pass the returned `nextCursor`. When `hasMore` is `false`, `nextCursor` is `null`.
- We fetch `limit + 1` rows to compute `hasMore` without a second COUNT query.
- `category=all` (or omitted) returns the unfiltered feed.

`POST /admin/seed-batch` `{ "count": 50 }` — inserts N fresh products with `created_at = now()`. **Demo only** (not authenticated); used to show consistency live. Remove or protect before any real deployment.

`GET /health` — `{ "ok": true }`.

---

## Run locally

Prereq: Node 18+ and a Postgres connection string (Supabase or local).

```bash
# 1. Seed the database (also creates schema + indexes)
cd db
npm install
cp .env.example .env        # then put your DATABASE_URL in .env
npm run seed                # ~a few seconds for 200k rows
npm run verify              # proves index usage + no-dup/no-miss (optional)

# 2. Backend
cd ../backend
npm install
cp .env.example .env        # same DATABASE_URL
npm start                   # http://localhost:3000

# 3. Frontend
cd ../frontend
npm install
cp .env.example .env        # VITE_API_URL=http://localhost:3000
npm run dev                 # http://localhost:5173
```

---

## Deploy (Supabase + Render, free tier)

### 1. Supabase (database)
1. Create a free project at supabase.com.
2. **Project Settings → Database → Connection string → URI** (use the **Session pooler**, port `5432`). Append `?sslmode=require`. This is your `DATABASE_URL`.
3. Seed it from your machine: `cd db && npm install && DATABASE_URL="..." npm run seed`.

### 2. Render (backend + frontend)
1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` defines both services.
3. On **product-browse-api**, set env var `DATABASE_URL` to the Supabase URI.
4. On **product-browse-web**, set env var `VITE_API_URL` to the deployed API URL (e.g. `https://product-browse-api.onrender.com`), then trigger a redeploy so the build picks it up.

Notes (free tier): Render web services **spin down after ~15 min idle** — the first request after sleep takes ~30–50s (cold start). Supabase free projects **pause after ~1 week of inactivity**; open the dashboard to resume.

---

## Verifying the guarantees

`cd db && npm run verify` checks, directly against your database:

1. **Index usage** — `EXPLAIN` of a deep-cursor query shows `Index Scan` (never `Seq Scan`) for both the unfiltered and category feeds.
2. **No-dup / no-miss** — a full keyset walk of the table returns every id exactly once, in strict `(created_at DESC, id DESC)` order.
3. **Stable under concurrent inserts** — repeats the walk while injecting 50 fresh rows mid-scan; still zero duplicates, and the new rows correctly sit above the cursor instead of disturbing the in-flight window.

In the UI you can reproduce #3 by hand: click **"Add 50 products"**, then keep clicking **"Load more"** to the end — the counter never re-shows an id and never skips one. (The app also flags any duplicate id loudly, which should never fire.)

---

## Out of scope
- `updated_at`-ordered ("most recently touched") feed — needs a pinned snapshot timestamp; not built since "newest first" = created order.
- Auth, product detail pages, and write/update endpoints beyond the demo `seed-batch`.
