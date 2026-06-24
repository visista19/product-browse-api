import { useCallback, useEffect, useRef, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
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

  const addFifty = async () => {
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/admin/seed-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 50 }),
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
      <p className="sub">
        Keyset (cursor) pagination over ~200k products · newest first ·{' '}
        <code>{items.length}</code> loaded
      </p>

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
        <button onClick={addFifty}>+ Add 50 products (consistency demo)</button>
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
