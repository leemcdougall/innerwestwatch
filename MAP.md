# Inner West Watch — repository map

The top-level index. Every significant directory has its own `MAP.md` that describes its contents and
points further down. **This map points; it does not copy.** Detail lives at exactly one level, so a
change lands in one place and parents can't go stale.

A plain-language digest of Inner West Council meeting documents — "what does this decision mean for my
street?" Live at https://innerwestwatch.pages.dev (Cloudflare Pages, auto-deploys on push to `main`).

## Orientation (read at session start)

| Read | For |
|---|---|
| `memory/MAP.md` → `memory/status.md` | Current state + a live-query to verify today's data shape. **Start here.** |
| `GOALS.md` | Milestones, architecture, module map. |
| `CONTEXT.md` | Domain glossary (Committee, Meeting, Document, Topic, AgendaItem). |
| `CHANGELOG.md` | Session-by-session build history. |
| `docs/adr/MAP.md` | Why the architecture is shaped this way. |

Then run `gh issue list` (open work) and `wrangler whoami` (Cloudflare auth), and the live-data query
in `memory/status.md` (never trust a hardcoded count — the database is the source of truth).

## The tree (each links to its own MAP)

| Directory | What's in it | Committed? |
|---|---|---|
| `memory/` | Project memory — status, direction, design, conventions, research workspace, reference data. | **No** (gitignored, local working context) |
| `db/` | D1 schema, ingest, reconciliation, migrations. Source of truth for all item data. | Yes |
| `functions/` | Cloudflare Pages Functions — the `/api/items` Worker. | Yes |
| `docs/adr/` | Architecture decision records. | Yes |
| `app/` | Shared frontend toolkit (CSS/JS) — **parked**, lands with the Milestone 7 frontend (WIP on `claude/m7-frontend-slice`). | Yes |
| `meetings/` | Hand-built level-3 detail pages (Tempe South is the reference — do not touch). | Yes |
| `data/` | `items.json` — historical record only; D1 is the real source of truth. | Yes |
| `backups/`, `review/` | D1 backups + match.js review output — large, regenerable. | No (gitignored) |

Top-level files: `index.html` (home feed), `topic.html` (issue detail, WIP), `wrangler.toml`
(Pages + D1 config). Full detail in `GOALS.md`.

## The two rules that keep this honest

1. **Point, don't duplicate.** Detail lives at one level. History → `CHANGELOG.md`, architecture →
   `GOALS.md`, terms → `CONTEXT.md`, decisions → `docs/adr/`, project memory → `memory/`. Parents give
   a one-line hook and a pointer, never a copy. (This is what the old "17 items" mistake violated.)
2. **A structural change updates the MAP at its level + the one-line hook in its parent.** Add/remove/
   rename anything structural → fix that directory's `MAP.md` and the row for it one level up. That's
   how "everywhere remembers it" without a grep hunt.
