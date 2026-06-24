/**
 * Product feed routes — keyset (cursor) pagination, newest-first.
 */
const express = require('express');
const { pool } = require('./db');
const { encodeCursor, decodeCursor } = require('./cursor');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * GET /products?category=<opt>&cursor=<opt>&limit=<opt>
 *
 * Ordered by (created_at DESC, id DESC). We fetch limit+1 rows so we can tell
 * whether another page exists without a second COUNT query. Because the feed is
 * ordered by the immutable created_at, rows created after a reader starts paging
 * land ABOVE the cursor and can never be seen twice or missed within a pass.
 */
router.get('/products', async (req, res) => {
  const limit = clampLimit(req.query.limit);
  const category = req.query.category && req.query.category !== 'all'
    ? String(req.query.category)
    : null;

  // Decode the cursor (if any) up front so a bad token is a clean 400.
  let cursor = null;
  if (req.query.cursor) {
    try {
      cursor = decodeCursor(String(req.query.cursor));
    } catch {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  // Build the query dynamically. Equality filter (category) and the keyset
  // predicate are both optional; the SELECT/ORDER BY are constant.
  const where = [];
  const params = [];

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  if (cursor) {
    // Row-value comparison maps directly onto the (… DESC, id DESC) index.
    params.push(cursor.ts);
    const tsParam = params.length;
    params.push(cursor.id);
    const idParam = params.length;
    // Explicit casts so the row-value comparison is unambiguous: the params are
    // a timestamptz and a bigint, matching the (created_at, id) columns exactly.
    where.push(`(created_at, id) < ($${tsParam}::timestamptz, $${idParam}::bigint)`);
  }

  params.push(limit + 1); // fetch one extra to detect hasMore
  const limitParam = params.length;

  const sql = `
    SELECT id, name, category, price, created_at, updated_at
    FROM products
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitParam}
  `;

  try {
    const { rows } = await pool.query(sql, params);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      nextCursor = encodeCursor(last.created_at, last.id);
    }

    res.json({ data, nextCursor, hasMore });
  } catch (err) {
    console.error('GET /products failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /admin/seed-batch  { count?: number }
 *
 * Inserts N products with created_at = now() so a reviewer can watch new rows
 * enter at the TOP of the feed while paging, and confirm no duplicate / no miss.
 * Demo-only endpoint (not auth-protected) — documented as such in the README.
 */
router.post('/admin/seed-batch', async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 50, 1), 1000);
  try {
    await pool.query(
      `
      INSERT INTO products (name, category, price, created_at, updated_at)
      SELECT
        'New Product ' || to_char(now(), 'HH24:MI:SS') || ' #' || g,
        (ARRAY['electronics','books','toys','home','sports','beauty'])[1 + (random()*5)::int],
        round((random()*490 + 10)::numeric, 2),
        now(), now()
      FROM generate_series(1, $1) AS g
      `,
      [count]
    );
    res.json({ inserted: count });
  } catch (err) {
    console.error('POST /admin/seed-batch failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
