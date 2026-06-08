# Inner West Watch — Project Guide

## Read these at the start of every session

- `GOALS.md` — what we're building, architecture, module map, milestone status
- `CONTEXT.md` — canonical domain glossary (Committee, Meeting, Document, Topic, AgendaItem)
- `CHANGELOG.md` — what has been built and when
- `docs/adr/` — architecture decisions with full reasoning

Then run:
```bash
gh issue list
wrangler whoami
```

`gh issue list` shows open work. `wrangler whoami` confirms Cloudflare auth is still valid.

---

## What this project is

A plain-language digest of Inner West Council meeting documents. Source: formal agenda PDFs and infocouncil.biz pages. Output: a resident-friendly site that answers "what does this mean for my street?"

Audience: neighbours who would never read a council agenda but care when road works are coming, parking rules are changing, or a new crossing is going in nearby.

---

## Repo and live site

**Repo:** https://github.com/leemcdougall/innerwestwatch  
**Local:** `/Users/ca/Library/CloudStorage/Box-Box/Lee's Documents/innerwestwatch/` — this IS the git repo root. No subdirectories.  
**Live site:** https://innerwestwatch.pages.dev  
**Host:** Cloudflare Pages (account: Leeamcdougall@gmail.com) — auto-deploys on every push to `main`.

---

## Folder structure

```
innerwestwatch/          ← git repo root
  CLAUDE.md              ← this file (loaded every session)
  GOALS.md               ← milestones, architecture, module map
  CONTEXT.md             ← domain glossary
  CHANGELOG.md           ← session-by-session build history
  index.html             ← home page: suburb-filtered card feed
  wrangler.toml          ← Cloudflare Pages + D1 config
  data/
    items.json           ← historical record only (D1 is source of truth)
  db/
    schema.sql           ← D1 schema (7 tables)
    migrate.js           ← generates seed.sql from items.json
    seed.sql             ← generated — do not edit by hand
  functions/
    api/
      items.js           ← Worker: GET /api/items
  docs/
    adr/                 ← architecture decision records
  meetings/
    ltf-18may2026/
      tempe-south/
        index.html       ← level-3 detail page — DO NOT TOUCH
```

---

## Source of truth

**D1 database (`counciltracker`)** is the source of truth for all item data — not `data/items.json`.

To update item data: write SQL against D1 via `wrangler d1 execute counciltracker --remote`.  
To re-seed from scratch: `node db/migrate.js && wrangler d1 execute counciltracker --file=db/seed.sql --remote`.

Database ID: `d721d0be-87d8-45dd-b2ee-56f06d9010ba` (region OC/Sydney)

---

## Branch strategy

```
main          ← live. Never commit directly.
  └── beta    ← staging. Test here before going live.
        └── claude/<feature>   ← one session = one branch from beta.
```

Workflow:
1. `git checkout beta && git checkout -b claude/<short-descriptive-name>`
2. Make changes, commit to the feature branch.
3. `gh pr create --base beta --head claude/<name>`
4. Merge the PR into beta, then PR beta → main and merge to go live.
5. **Merge PRs yourself** — the job ends at deploy, not at PR creation.

**No worktrees.** Work directly in the repo on named branches. Never use `isolation: "worktree"` when spawning agents.

---

## Infrastructure

| Thing | Detail |
|---|---|
| Cloudflare account | Leeamcdougall@gmail.com |
| D1 database | `counciltracker` |
| Wrangler | `/usr/local/bin/wrangler` — check auth with `wrangler whoami` |
| Node | `/usr/local/bin/node` (v22.22.3 via nvm) |
| Worker | `GET /api/items?suburb=&street=` |

Full infrastructure detail: memory file `cloudflare_access.md`.

---

## infocouncil.biz URL patterns

**Agendas:** `Open/{YYYY}/{MM}/LTF_{DDMMYYYY}_AGN_{ID}_AT.HTM`  
**Minutes:** `Open/{YYYY}/{MM}/LTF_{DDMMYYYY}_MIN_{ID}.HTM`

Known 2026 LTF meetings:

| Date | ID | Minutes? |
|------|-----|---------|
| 18 May 2026 | 4285 | Yes |
| 20 Apr 2026 | 4284 | Yes |
| 16 Mar 2026 | 4283 | Yes |
| 16 Feb 2026 | 4282 | Yes |

---

## Writing rules

- Lead with impact: what's changing, where, when. Process comes last.
- No jargon without a plain-language explanation: no LTF, LATM, TMP, kerb blister, raised threshold without a one-line gloss.
- Scannable in under 30 seconds. Bold street names. Use tags and suburb labels.
- Every item links to the original infocouncil agenda. The site is a digest, not a replacement.
- Never publish a half-finished detail page. Link to infocouncil instead.
- Keep rich comments in all code — future readers must understand structure and decisions without reading the full git history.

---

## Session logging — do this at the end of every session

Before closing out, update the following. Do not skip these even if the session was short.

### Always update

**`CHANGELOG.md`** — add an entry for this session:
- Date and one-line summary as the heading
- What was built or changed (bullet points, specific files)
- Any decisions made and why
- New GitHub Issues opened
- Issues closed

**`project_status.md`** (memory file) — update:
- "Current state" section with today's date
- What's built and live
- Next steps in priority order

**`GOALS.md`** — update if:
- A milestone was completed (mark ✅ with date)
- A new milestone or module was discussed
- The architecture changed

**`CONTEXT.md`** — update if:
- A new term was defined or clarified during the session
- An existing term's meaning shifted

### Update if relevant

**Memory files** — update whichever apply:
- `cloudflare_access.md` — if any infrastructure changed (new database, new Worker, re-auth)
- `feedback_*.md` — if Lee gave feedback on approach, corrected something, or confirmed a non-obvious decision
- `ltf_meeting_index.md` — if item statuses changed or a new meeting was added
- `site_design_intent.md` — if design principles evolved

### Create if needed

- New `docs/adr/XXXX-name.md` — if a hard-to-reverse, surprising, or genuinely trade-off decision was made
- New `feedback_*.md` memory file — if new working style feedback doesn't fit an existing file
- New `ltf_[date]_index.md` — if a new LTF meeting was added

### Commit repo file changes

Any changes to `CHANGELOG.md`, `GOALS.md`, `CONTEXT.md`, or `docs/adr/` should be committed to git at the end of the session. Follow the branch strategy — commit on the current feature branch or open a dedicated `claude/docs-update` branch if the session was documentation-only.

---

## Memory system

Persistent memory lives at:
`~/.claude/projects/-Users-ca-Library-CloudStorage-Box-Box-Lee-s-Documents-innerwestwatch/memory/`

Key files:
- `project_status.md` — current state, what's built, what's next
- `cloudflare_access.md` — full Cloudflare/wrangler/D1 details
- `github_workflow.md` — repo, hosting, branch strategy
- `site_design_intent.md` — design principles and architecture
- `ltf_meeting_index.md` — all 17 items from 18 May 2026 LTF with outcomes
- `ltf_tempe_detail.md` — Tempe South street-level detail
- `feedback_*.md` — working style preferences

Always update `project_status.md` at the end of a session with what changed and what's still to do.
