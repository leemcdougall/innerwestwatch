# functions/ — Cloudflare Pages Functions (the API)

Server-side code that runs on Cloudflare Pages. Deployed automatically on push to `main`.

| Path | What it does |
|---|---|
| `api/items.js` | `GET /api/items` — returns one object per **topic** with threaded `decisions[]`, neutral `stage`, union `suburbs`/`streets`. Filters: `?suburb=X`, `?street=Y` (repeatable); matches if ANY decision touched that place. **Known gap:** does not yet serve `relations[]` or `images[]` though both exist in D1 — see `memory/status.md` next-steps. |

**Structural change → update this MAP + the `functions/` hook in the repo-root `MAP.md`.**
