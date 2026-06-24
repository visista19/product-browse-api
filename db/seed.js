#!/usr/bin/env node
/**
 * Seed script: creates the schema and bulk-inserts 200,000 products.
 *
 * IMPORTANT: this does NOT loop 200k INSERTs. It issues ONE server-side
 * `INSERT ... SELECT FROM generate_series(...)` statement, so Postgres builds
 * every row internally in a single round-trip (a few seconds). That is the
 * fastest way to seed at this scale.
 *
 * Usage:
 *   DATABASE_URL="postgres://...:5432/postgres?sslmode=require" node seed.js
 *   (or set DATABASE_URL in db/.env and run `npm run seed`)
 *
 * Optional env:
 *   SEED_COUNT   number of rows to generate (default 200000)
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const COUNT = Number(process.env.SEED_COUNT || 200000);

function buildSsl() {
  // Supabase (and most managed Postgres) require TLS. Local Postgres usually
  // does not, so only enable SSL when the URL asks for it or it's not localhost.
  const url = process.env.DATABASE_URL || '';
  if (/sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url) && !/sslmode=require/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Newer pg parses `sslmode=require` from the URL as strict `verify-full`, which
// rejects Supabase's self-signed cert chain. We strip it and control TLS via the
// `ssl` option above (rejectUnauthorized:false) instead.
function cleanConnectionString() {
  return (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/i, '');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. See db/.env.example.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: cleanConnectionString(),
    ssl: buildSsl(),
  });

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  console.log('Connecting...');
  await client.connect();

  console.log('Applying schema (tables + indexes)...');
  await client.query(schema);

  console.log('Clearing existing rows...');
  await client.query('TRUNCATE products RESTART IDENTITY');

  console.log(`Inserting ${COUNT.toLocaleString()} products via generate_series...`);
  const t0 = Date.now();
  await client.query(
    `
    INSERT INTO products (name, category, price, created_at, updated_at)
    SELECT name, category, price, ts, ts
    FROM (
      SELECT
        'Product ' || g AS name,
        (ARRAY['electronics','books','toys','home','sports','beauty'])[1 + (random()*5)::int] AS category,
        round((random()*490 + 10)::numeric, 2) AS price,
        now() - (random() * 365) * interval '1 day' AS ts
      FROM generate_series(1, $1) AS g
      OFFSET 0   -- optimizer fence: keeps the subquery from being flattened so the
                 -- volatile random()/now() in 'ts' is evaluated ONCE PER ROW (not
                 -- once for the whole statement) and the same ts feeds both columns.
    ) AS rows
    `,
    [COUNT]
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const { rows } = await client.query('SELECT count(*)::int AS n FROM products');
  console.log(`Done in ${secs}s. products table now has ${rows[0].n.toLocaleString()} rows.`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
