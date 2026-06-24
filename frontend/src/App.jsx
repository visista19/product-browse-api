import { useCallback, useEffect, useRef, useState } from 'react';

// Strip any trailing slash(es) so a VITE_API_URL like "https://api.example.com/"
// doesn't produce a double-slash request ("...com//products") that 404s.
const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CATEGORIES = ['all', 'electronics', 'books', 'toys', 'home', 'sports', 'beauty'];
const PAGE_SIZE = 20;

export default function App() {
  const [category, setCategory] = useState('all');
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [addCount, setAddCount] = useState(50);

  // Track ids already shown so we can visibly prove "no duplicates" across pages.
  const seenIds = useRef(new Set());

  const fetchPage = useCallback(
    async (cat, cur, reset) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cat && cat !== 'all') params.set('category', cat);
        if (cur) params.set('cursor', cur);

        const res = await fetch(`${API_URL}/products?${params.toString()}`);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json();

        if (reset) seenIds.current = new Set();
        let dupes = 0;
        const incoming = json.data.filter((p) => {
          if (seenIds.current.has(p.id)) {
            dupes += 1;
            return false;
          }
          seenIds.current.add(p.id);
          return true;
        });
        if (dupes > 0) {
          // Should never happen with keyset on immutable created_at — surfaced loudly if it ever does.
          setNotice(`⚠ ${dupes} duplicate id(s) detected this page (unexpected!)`);
        }

        setItems((prev) => (reset ? incoming : [...prev, ...incoming]));
        setCursor(json.nextCursor);
        setHasMore(json.hasMore);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Reload from the top whenever the category changes.
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    fetchPage(category, null, true);
  }, [category, fetchPage]);

  const loadMore = () => {
    if (cursor && !loading) fetchPage(category, cursor, false);
  };

  const addProducts = async () => {
    setNotice(null);
    // Clamp to the backend's accepted range (1..1000); fall back to 50 if blank.
    const count = Math.max(1, Math.min(1000, parseInt(addCount, 10) || 50));
    try {
      const res = await fetch(`${API_URL}/admin/seed-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      const json = await res.json();
      setNotice(
        `Inserted ${json.inserted} fresh products at the top. Keep clicking "Load more" — ` +
          `because the feed is ordered by immutable created_at, these never appear inside ` +
          `your current paging window, so you won't see a duplicate or skip one.`
      );
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="wrap">
      <h1>Product Browser</h1>

      <div className="controls">
        <label>
          Category:{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Add{' '}
          <input
            type="number"
            min="1"
            max="1000"
            value={addCount}
            onChange={(e) => setAddCount(e.target.value)}
            style={{ width: 70 }}
          />{' '}
          products
        </label>
        <button onClick={addProducts}>+ Add (consistency demo)</button>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">Error: {error}</div>}

      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>name</th>
            <th>category</th>
            <th>price</th>
            <th>created_at</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>{p.name}</td>
              <td>{p.category}</td>
              <td>${Number(p.price).toFixed(2)}</td>
              <td>{new Date(p.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footer">
        {hasMore ? (
          <button onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          <span className="muted">{loading ? 'Loading…' : 'End of results'}</span>
        )}
      </div>
    </div>
  );
}
