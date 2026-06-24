-- Schema for the product browse API.
-- Idempotent: safe to run repeatedly. seed.js runs this before inserting data.

CREATE TABLE IF NOT EXISTS products (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT          NOT NULL,
  category    TEXT          NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  -- timestamptz(3) = millisecond precision. This matters for cursor pagination:
  -- JavaScript's Date only holds milliseconds, so if the DB stored microseconds,
  -- a cursor built from a JS Date would be truncated and no longer match the
  -- stored value exactly, skipping boundary rows. Pinning the column to ms makes
  -- the round-trip lossless.
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- Keyset (cursor) pagination indexes.
--
-- We order the feed by (created_at DESC, id DESC). `id` is a mandatory tiebreaker
-- because many rows share the same created_at, so created_at alone is not unique
-- and the cursor would be ambiguous. The tuple (created_at, id) IS globally unique
-- and stable, which is exactly what keyset pagination needs.

-- Unfiltered feed:  WHERE (created_at,id) < (cur_ts,cur_id) ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_products_feed
  ON products (created_at DESC, id DESC);

-- Category-filtered feed. The equality-filter column (category) MUST come first,
-- then the range/sort columns. An index of (created_at, id, category) could NOT
-- seek on category, so it would scan-then-filter. category-first lets Postgres
-- do a single index seek for "WHERE category = $1 AND (created_at,id) < (...)".
CREATE INDEX IF NOT EXISTS idx_products_cat_feed
  ON products (category, created_at DESC, id DESC);
