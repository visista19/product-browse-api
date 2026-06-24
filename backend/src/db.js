/**
 * Shared pg connection pool.
 *
 * Supabase requires TLS; we accept its certificate chain with
 * rejectUnauthorized:false (standard for managed Postgres behind a pooler).
 * Local Postgres without sslmode=require runs without SSL.
 */
const { Pool } = require('pg');

function buildSsl() {
  const url = process.env.DATABASE_URL || '';
  if (/sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url) && !/sslmode=require/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Newer pg parses `sslmode=require` from the URL as strict `verify-full`, which
// rejects Supabase's self-signed cert chain. Strip it; TLS is controlled by the
// `ssl` option above instead.
function cleanConnectionString() {
  return (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/i, '');
}

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. See backend/.env.example.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: cleanConnectionString(),
  ssl: buildSsl(),
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected idle pool client error', err);
});

module.exports = { pool };
