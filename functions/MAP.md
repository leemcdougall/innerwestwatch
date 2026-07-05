# functions/ — Cloudflare Pages Functions (the API)

Server-side code that runs on Cloudflare Pages. Deployed automatically on push to `main`.

| Path | What it does |
|---|---|
| `api/items.js` | `GET /api/items` — returns one object per **topic** with threaded `decisions[]`, neutral `stage` + resident `label`, union `suburbs`/`streets`, `relations[]` (linked topics + direction, ADR 0005), and `images[]` (infocouncil diagram URLs). Each decision carries `residentSentence`, `commitment`, `outcomeUnclear`, and its own honest `label` (ADR 0008; six-word vocab imported from `db/lib/labels.js`). Filters: `?suburb=X`, `?street=Y` (repeatable); matches if ANY decision touched that place. |

**Structural change → update this MAP + the `functions/` hook in the repo-root `MAP.md`.**
