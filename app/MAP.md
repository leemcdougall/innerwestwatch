# app/ — shared frontend toolkit

Shared CSS/JS used by the pages (`index.html`, `topic.html`). Part of the Milestone 7 frontend rebuild
(WIP on branch `claude/m7-frontend-slice`). The frontend renders whatever the middle layer produces —
see `memory/direction.md`.

| File | What it does |
|---|---|
| `iw.css` | Shared styles for the feed + topic pages. |
| `iw.js` | Shared rendering helpers (fetches `/api/items`, builds cards/lists). |
| `follow.js` | "Follow" via localStorage — lets a resident track a street/suburb/topic. |

Note: the ward map + suburb aliases (`Roselle`→Rozelle, `East Balmain`→Balmain East) currently live in
`index.html`'s inline script, not here.

**Structural change → update this MAP + the `app/` hook in the repo-root `MAP.md`.**
