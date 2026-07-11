# ADR 0010: Projects, a followable grouping above topics

**In plain English:** residents can follow one big real thing (the Leichhardt pool, the GreenWay) as
one page, even though the database stores it as many separately-named records. The group is called a
**Project**, a person confirms every group before it publishes, and the master copy is stored so that
re-importing data can never destroy it.

**Status:** Accepted
**Date:** 2026-07-11 (session 25, design session for #85, "let residents follow one big project as one thing")
**Extends:** ADR 0003 (persistent topics, thread never merge), ADR 0005/0006 (topic relations, subject-keyed source)

## Context

ADR 0003 threads recurring appearances of the *same-named* subject onto one persistent Topic. That
model holds, but the unit a resident wants to follow often sits a level above it: one real-world
standing thing whose council appearances carry many *different* names, which subject-matching can
never join. The design session verified this against live data:

1. **Leichhardt Park Aquatic Centre**: 8 topics, 14 decisions, Aug 2025 to Jun 2026. The main
   upgrade, Stage 2 tender, Stage 2 playground and shade, a monthly update, a confidential monthly
   update, children's pool staffing, swimming continuity during renovation. One real pool; eight
   unjoined records. Only one human relation touches the cluster.
2. **GreenWay**: ~9 topics (governance, activation program, lighting, bushcare and signage, traffic
   safety at Weston St, privacy at Williams Parade, an art prize). A place/program, not a
   construction job, so the model must fit more than "works".
3. **Parramatta Road corridor rezoning**: 3 topics (a community address, a report, a motion), one
   state-led program.

The same sweeps produced the boundary evidence that shapes the safety rules:

- **The Metro trap.** A name sweep for "metro" mixes Sydney Metro (the rail line) with Marrickville
  Metro (a shopping centre). Name-matching alone would group different real things: a published
  falsehood, the exact risk ADR 0003 and the Milestone 6 review discipline exist to prevent.
- **Different pools share words.** Annette Kellerman, Fanny Durack and Ashfield aquatic centres all
  fuzzy-match "aquatic centre" but are distinct places.
- **Some items span several things.** "Dive-In Cinema at aquatic centres" and "SES access to
  aquatic facilities" touch multiple pools at once, so membership cannot be one-to-one.

Constraint carried in from ADR 0003: whatever grouping is, it must not become the merge model that
ADR 0002 tried and ADR 0003 rejected. Each record is a distinct council matter with its own evidence
trail; collapsing them rewrites history.

## Decision

Lee made four product calls on 2026-07-11; the rest follows established patterns.

### 1. The new domain term is **Project** (Lee's name, 2026-07-11)

A Project is a named real-world standing thing (a place, program, event or works) that groups many
Topics. Residents follow Projects; Topics keep their own pages and remain the evidence layer.
Canonical definition lives in `CONTEXT.md`. "Project" was chosen over "Story" (reads editorial) and
"Place" (breaks for festivals and programs).

### 2. Grouping is an annotation above Topics, never a merge

No topic row changes, moves or disappears. A Project is only a name, a one-line description, and a
membership list. ADR 0003's thread-never-merge rule still governs everything below it.
**Membership is many-to-many**: a topic may belong to several Projects or none (the Dive-In Cinema
case).

### 3. Storage follows the ADR 0006 pattern: subject-keyed source, derived tables

- **Source of truth:** `db/projects.json`, version-controlled. Each project carries a stable
  **human-chosen id** (a slug a person wrote, never derived from AI-extracted text, so it cannot
  churn), a `name`, a plain-English `description`, and `members[]` keyed by **subject**, not topic
  id. Git holds the irreplaceable human judgement.
- **Derived projection:** D1 tables `projects` and `project_topics`, re-materialised by
  `db/apply-projects.js` (mirrors `db/apply-relations.js`): resolve each member subject to the
  current topic id via the `topic_subjects` alias store, insert idempotently, report anything that
  no longer resolves. A re-import can never destroy a Project; at worst it produces a short
  unresolved-subjects report for a human.

### 4. Machine proposes, human confirms; oversight trends to zero

- A clustering pass (extension of `db/match.js`) proposes candidate Projects and candidate new
  members. It never writes: **nothing publishes without a human yes.** Candidates are verified
  against the infocouncil source documents, not stored headlines (the Curtis Rd lesson).
- Every confirmation is permanent: membership lives in `projects.json` keyed by subject, so the same
  question is never re-asked. The weekly importer (`db/append-weekly.js`) reports new topics that
  resemble a known Project's members as proposals for a quick human yes/no; it never auto-joins.
- The 73 existing `topic_relations` stay untouched. Relations answer "what else touches this?";
  membership answers "what is this part of?". Some parent-child links may also be memberships, and
  promoting one is a per-link human call during the seeding review, not a bulk conversion.

### 5. No Project-level stage; the follow view is one timeline

- **What a resident sees** (the contract for the frontend rebuild, #86): the Project's name and
  description, a "where it's up to" line (the newest member decision's resident sentence and date),
  then **one dated timeline of every Decision across all member Topics, newest first**, each with
  its own resident sentence, honest label and source link. This reuses the per-decision sentence and
  label work (ADR 0008) unchanged, one level up.
- **A Project has no rolled-up status word.** The pool proves a single word would lie: Stage 2 is
  underway while children's pool staffing is still being looked into. Each member decision keeps its
  own label; the latest sentence carries the summary.

### 6. API contract (built later, stated now so #86 can rely on it)

- `/api/items`: each topic object gains `projects: [{ id, name }]`.
- A project listing (route settled at build, likely `/api/projects`): per project `id`, `name`,
  `description`, member topic ids/subjects, and the latest decision (date, residentSentence, label).

## Why not the alternatives

- **Merge the cluster into one topic.** Rejected: ADR 0003's core reasoning. The Stage 2 tender and
  the children's-pool staffing motion are different council matters with different outcomes; one
  merged row erases that and republishes the falsehood risk.
- **Promote `topic_relations` clusters into groups automatically.** Rejected: relations encode
  several meanings (context, hierarchy, replacement), and only a human can say which parent-child
  links are really membership. Bulk conversion would bake guesses into a published grouping.
- **Group by name-matching at import time.** Rejected: the Metro trap and the three distinct
  "aquatic centre" pools show shared words are not shared identity.
- **Free-text tags on topics.** Rejected: a tag has no stable identity, no description, no timeline
  contract, and no durable home, so it fails both the resident (nothing to follow) and the re-import
  test (nothing to restore).

## Consequences

- Three build issues carry the implementation: #92 (storage: `projects.json`, tables, apply script),
  #93 (matcher proposal pass + human review seeding the first Projects: the pool, the GreenWay, the
  Parramatta Rd corridor), #94 (API: per-topic project refs + project listing). Build order 92 → 93 → 94.
- `CONTEXT.md` gains the **Project** term; "follow a Project" joins the planned entry points.
- The frontend rebuild (#86, ON HOLD) now has the grouping contract it was waiting on; the parked
  home-page-feed question (`memory/home-page-feed-question.md`) has its followable unit defined but
  remains its own session.
- New D1 tables arrive by migration; the schema-housekeeping issue (#87) is unaffected.
