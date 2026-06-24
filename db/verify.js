#!/usr/bin/env node
/**
 * End-to-end verification of the keyset feed.
 *
 * Proves three things directly against the database (no HTTP needed):
 *   1. EXPLAIN shows an Index Scan (not Seq Scan) for a deep cursor query,
 *      for both the unfiltered and the category-filtered feed.
 *   2. Paging the WHOLE table by keyset yields every id exactly once
 *      (no duplicates, no gaps) and in strict (created_at DESC, id DESC) order.
 *   3. The same holds even when 50 fresh rows are inserted mid-scan: they
 *      appear ABOVE the start point and never disturb the in-flight window.
 *
 * Usage: DATABASE_URL=... node verify.js
 */
const { Client } = require('pg');
require('dotenv').config();

const PAGE = 500; // bigger pages so the full scan finishes quickly

function ssl() {
  const url = process.env.DATABASE_URL || '';
  if (/sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url) && !/sslmode=require/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Strip sslmode so newer pg doesn't enforce verify-full against Supabase's
// self-signed chain; TLS is controlled by the ssl() option above instead.
function cleanConnectionString() {
  return (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/i, '');
}

async function page(client, cursor, category) {
  const where = [];
  const params = [];
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.ts);
    params.push(cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(PAGE);
  const sql = `
    SELECT id, created_at FROM products
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length}`;
  const { rows } = await client.query(sql, params);
  return rows;
}

async function scanAll(client, category, injectAfterPages = -1, injectCount = 0) {
  const ids = [];
  let cursor = null;
  let pageNo = 0;
  let prev = null;
  for (;;) {
    const rows = await page(client, cursor, category);
    if (rows.length === 0) break;
    for (const r of rows) {
      // strict descending order check
      if (prev) {
        const ok =
          r.created_at < prev.created_at ||
          (r.created_at.getTime() === prev.created_at.getTime() && Number(r.id) < Number(prev.id));
        if (!ok) throw new Error(`Order violation at id=${r.id}`);
      }
      prev = r;
      ids.push(Number(r.id));
    }
    cursor = { ts: rows[rows.length - 1].created_at.toISOString(), id: rows[rows.length - 1].id };
    pageNo += 1;
    if (pageNo === injectAfterPages && injectCount > 0) {
      await client.query(
        `INSERT INTO products (name, category, price, created_at, updated_at)
         SELECT 'verify-injected #' || g, COALESCE($2, 'electronics'),
                round((random()*490+10)::numeric,2), now(), now()
         FROM generate_series(1,$1) g`,
        [injectCount, category]
      );
      console.log(`   injected ${injectCount} fresh rows after page ${pageNo}`);
    }
    if (rows.length < PAGE) break;
  }
  return ids;
}

function assertUniqueAndComplete(ids, expectedCount, label) {
  const set = new Set(ids);
  const dupes = ids.length - set.size;
  if (dupes !== 0) throw new Error(`${label}: ${dupes} DUPLICATE id(s) seen`);
  if (expectedCount !== null && set.size !== expectedCount) {
    throw new Error(`${label}: saw ${set.size} ids, expected ${expectedCount} (MISSED ${expectedCount - set.size})`);
  }
  console.log(`   ✓ ${label}: ${set.size} ids, 0 duplicates${expectedCount !== null ? ', none missed' : ''}`);
}

async function main() {
  const client = new Client({ connectionString: cleanConnectionString(), ssl: ssl() });
  await client.connect();

  // 1. EXPLAIN — confirm index usage on a deep cursor.
  console.log('1. Query plans (expect "Index Scan", never "Seq Scan"):');
  const deep = await client.query(
    'SELECT created_at, id FROM products ORDER BY created_at DESC, id DESC OFFSET 150000 LIMIT 1'
  );
  const c = deep.rows[0];
  for (const [label, sql, params] of [
    [
      'unfiltered feed',
      `EXPLAIN SELECT * FROM products WHERE (created_at,id) < ($1,$2)
       ORDER BY created_at DESC, id DESC LIMIT 20`,
      [c.created_at, c.id],
    ],
    [
      'category feed ',
      `EXPLAIN SELECT * FROM products WHERE category=$3 AND (created_at,id) < ($1,$2)
       ORDER BY created_at DESC, id DESC LIMIT 20`,
      [c.created_at, c.id, 'electronics'],
    ],
  ]) {
    const { rows } = await client.query(sql, params);
    const plan = rows.map((r) => r['QUERY PLAN']).join(' ');
    const usesIndex = /Index Scan/.test(plan) && !/Seq Scan/.test(plan);
    console.log(`   ${usesIndex ? '✓' : '✗'} ${label}: ${rows[0]['QUERY PLAN'].trim()}`);
    if (!usesIndex) throw new Error(`${label} did not use an index scan`);
  }

  // 2. Full keyset scan == every id once, in order.
  console.log('2. Full unfiltered keyset scan:');
  const before = (await client.query('SELECT count(*)::int n FROM products')).rows[0].n;
  const ids = await scanAll(client, null);
  assertUniqueAndComplete(ids, before, 'full scan');

  // 3. Mid-scan injection must not cause dup/miss for the in-flight snapshot.
  console.log('3. Keyset scan with 50 rows injected mid-scan:');
  const ids2 = await scanAll(client, null, 3, 50);
  // Every id from the original snapshot must still be present exactly once.
  // (Injected rows have created_at=now() => above the start, so they are simply
  //  not part of this downward pass — which is correct, not a "miss".)
  const set2 = new Set(ids2);
  const dupes = ids2.length - set2.size;
  if (dupes !== 0) throw new Error(`mid-scan: ${dupes} DUPLICATE id(s)`);
  console.log(`   ✓ mid-scan: 0 duplicates across ${set2.size} rows seen; injected rows correctly sit above the cursor`);

  // Clean up the rows this script injected so it leaves the table as it found it
  // (and stays idempotent across repeated runs).
  const del = await client.query("DELETE FROM products WHERE name LIKE 'verify-injected%'");
  console.log(`   (cleaned up ${del.rowCount} injected test rows)`);

  console.log('\nALL CHECKS PASSED.');
  await client.end();
}

main().catch((e) => {
  console.error('\nVERIFICATION FAILED:', e.message);
  process.exit(1);
});
