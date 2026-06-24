/**
 * Opaque cursor encoding for keyset pagination.
 *
 * A cursor captures the (created_at, id) of the LAST row returned on a page.
 * The next page asks for rows strictly "after" it in the (created_at DESC, id DESC)
 * order. We base64url-encode a small JSON blob so the client treats it as opaque
 * and cannot tamper with the sort semantics.
 */

function encodeCursor(createdAt, id) {
  // createdAt may be a Date (from pg) or an ISO string.
  const ts = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  const json = JSON.stringify({ ts, id: String(id) });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Returns { ts: string(ISO), id: string } or throws on malformed input.
 */
function decodeCursor(token) {
  let parsed;
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Malformed cursor');
  }
  if (!parsed || typeof parsed.ts !== 'string' || parsed.id === undefined) {
    throw new Error('Malformed cursor');
  }
  // Validate the timestamp and id are well-formed before they reach SQL.
  if (Number.isNaN(Date.parse(parsed.ts))) throw new Error('Malformed cursor');
  if (!/^\d+$/.test(String(parsed.id))) throw new Error('Malformed cursor');
  return { ts: parsed.ts, id: String(parsed.id) };
}

module.exports = { encodeCursor, decodeCursor };
