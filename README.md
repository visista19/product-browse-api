# Product Browse API — keyset pagination over 200k products

Browse ~200,000 products **newest-first**, **filter by category**, and **paginate fast at any depth** — while staying correct as data changes (no product seen twice, none missed).

- **Backend:** Node.js + Express + `pg`
- **DB:** PostgreSQL 
- **Frontend:** React 
- **Hosting:** Render free tier (backend web service + static frontend)

```
db/        schema.sql + seed.js (200k via generate_series) + verify.js
backend/   Express API: GET /products (keyset), POST /admin/seed-batch
frontend/  Vite + React UI: category filter, "Load more", consistency demo
render.yaml  Blueprint for both Render services
```


