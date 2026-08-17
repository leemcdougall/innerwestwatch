# Inner West Watch — Project Guide

## Read these at the start of every session

Start with **`MAP.md`** (repo root) — the top-level index of the whole project. It points down: every
significant directory has its own `MAP.md`, so you orient by reading maps, not by loading everything.
From there:

- `memory/MAP.md` → `memory/status.md` — **current state**, plus a live-query to verify today's data shape
- `GOALS.md` — what we're building, architecture, module map, milestone status
- `CONTEXT.md` — canonical domain glossary (Committee, Meeting, Document, Topic, AgendaItem)
- `CHANGELOG.md` — session-by-session build history
- `docs/adr/MAP.md` — architecture decisions with full reasoning

Then run:
```bash
gh issue list      # open work
wrangler whoami    # confirms Cloudflare auth is still valid
```

And get the **real data shape** — never trust a hardcoded count in a doc (that's the mistake that made
a past session think the project was 17 items when D1 held 594). The database is the source of truth:
```bash
wrangler d1 execute counciltracker --remote --command \
  "SELECT (SELECT COUNT(*) FROM topics) topics, (SELECT COUNT(*) FROM decisions) decisions, \
          (SELECT COUNT(*) FROM topic_relations) relations, (SELECT COUNT(*) FROM images) images"
```

---

## What this project is

A plain-language digest of Inner West Council meeting documents. Source: formal agenda PDFs and infocouncil.biz pages. Output: a resident-friendly site that answers "what does this mean for my street?"

Audience: neighbours who would never read a council agenda but care when road works are coming, parking rules are changing, or a new crossing is going in nearby.

---

## Repo and live site

**Repo:** https://github.com/leemcdougall/innerwestwatch  
**Local:** `/Users/lee/Library/CloudStorage/Box-Box/Lee's Documents/innerwestwatch/` — this IS the git repo root. No subdirectories.  
**Live site:** https://innerwestwatch.pages.dev  
**Host:** Cloudflare Pages (account: Leeamcdougall@gmail.com) — auto-deploys on every push to `main`.

---

## Folder structure — the self-describing tree

The layout lives in `MAP.md` (repo root), and each directory has its own `MAP.md` describing what's in
it and pointing further down. **Don't duplicate the tree here — read the maps.** Local root:
`/Users/lee/Library/CloudStorage/Box-Box/Lee's Documents/innerwestwatch/` — this IS the git repo root,
no subdirectories.

**The `MAP.md` convention (this is how the project stays consistent):**
- Every significant directory has a `MAP.md` listing its contents with a one-line hook each.
- **Point, don't duplicate.** Detail lives at one level; parents give a hook and a pointer, never a
  copy. History → `CHANGELOG.md`, architecture → `GOALS.md`, terms → `CONTEXT.md`, decisions →
  `docs/adr/`, project memory → `memory/`.
- **A structural change updates the MAP at its level + the one-line hook in its parent.** That's how a
  change is remembered everywhere without hunting for stale references.

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
| Wrangler | `/opt/homebrew/bin/wrangler` (v4.111.0, `npm install -g wrangler`) — check auth with `wrangler whoami` |
| Node | `/opt/homebrew/bin/node` (v22.23.1 via Homebrew `node@22`) |
| Worker | `GET /api/items?suburb=&street=` |

Full infrastructure detail: `memory/infra.md`.

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

## Tickets and engineer-speak — always translate (standing rule, locked 2026-07-07)

Lee tracks the project through GitHub Issues (his customer-service-ticket system) plus a kanban board
(project #1, https://github.com/users/leemcdougall/projects/1). **I am the sole GitHub operator — Lee
never touches it.** Every issue, PR, label, and board card move is mine, done by CLI in-session; never
rely on a GitHub UI automation or leave a step "for Lee to click". Keep the board in sync by hand: new
issue → add to board (Todo); start work → In Progress; close → Done. Board/field ids are in
`memory/conventions.md`.

When many changes land at once it's hard for him to keep up, so **every piece of engineer-speak carries
a plain-English "human part" alongside it — every session, forever.** The numbers stay; the meaning
gets translated. Full spec in `memory/conventions.md` ("Plain-English human layer on ALL
engineer-speak"). In short:

- **Issue bodies**: top `## In plain English` block (What this is / Why it matters / What happens next),
  then `---`, then `## Engineer detail` with the full technical content preserved.
- **Issue titles / ADR names**: plain human part first, engineer tag in parentheses.
- **In prose**: never a bare `#68` or `ADR 0009` — gloss it inline (already the "never a bare number" rule).
- **If the human wording is ever ambiguous, STOP and ask Lee to name it there and then.** Don't guess.

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

**`memory/status.md`** — update:
- Snapshot section with today's date and the latest live counts
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

**`memory/` files** (local, gitignored) — update whichever apply, and keep `memory/MAP.md` in sync if
you add/rename one:
- `memory/infra.md` — if any infrastructure changed (new database, new Worker, re-auth)
- `memory/conventions.md` — if Lee gave project-specific feedback (plain-language, issue labels, matching, verifying merges)
- `memory/design.md` — if design principles or map issues changed
- `memory/direction.md` — if the vision or priority shifted
- `memory/ltf-meeting-index.md` — if item statuses changed or a new meeting was added
- `memory/research-workspace.md` — if a new ad hoc Q&A / research example came up

General working-style feedback that isn't project-specific goes in the **harness** memory store, not
`memory/` (see the Memory system section below).

### Create if needed

- New `docs/adr/XXXX-name.md` (+ a row in `docs/adr/MAP.md`) — if a hard-to-reverse, surprising, or genuinely trade-off decision was made
- New `memory/` file (+ a row in `memory/MAP.md`) — if project memory doesn't fit an existing file
- New reference file in `memory/` — if a new LTF meeting or dataset was added

### Commit repo file changes

Any changes to `CHANGELOG.md`, `GOALS.md`, `CONTEXT.md`, or `docs/adr/` should be committed to git at the end of the session. Follow the branch strategy — commit on the current feature branch or open a dedicated `claude/docs-update` branch if the session was documentation-only.

---

## Memory system — two homes, one job each

Memory is split by *what it's about*, so the two homes never overlap or drift:

1. **Project memory → `memory/` in this repo** (local, **gitignored**, not on GitHub). Everything about
   Inner West Watch: current state, direction, design, conventions, the research workspace, reference
   data. Browse it via `memory/MAP.md`. This is the single home for project knowledge — read and write
   it here.

2. **General memory → the harness store** at
   `~/.claude/projects/-Users-lee-Library-CloudStorage-Box-Box-Lee-s-Documents-innerwestwatch/memory/`.
   Only genuinely cross-project things: who Lee is, his machine, his general working/writing style. Its
   `MEMORY.md` index points here, to the repo, for anything project-specific.

**Why gitignored:** memory is working context, not the product. The deployed site + committed repo stay
Inner West Council only. Personal-research inputs/outputs never get committed (see
`memory/research-workspace.md`).

At session end, update `memory/status.md` (current state + next steps) and keep `memory/MAP.md` in sync
if files change.
