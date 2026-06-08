# Inner West Watch — Domain Glossary

This file defines the canonical terms used across the project. Implementation details belong elsewhere.

---

## Committee

A persistent council body that holds meetings over time.

Examples: Local Transport Forum (LTF), Ordinary Council, Inner West Local Planning Panel, Flood Management Advisory Committee (FMACC).

A Committee is not a single event — it is an ongoing institution. Residents may follow a Committee to see everything it decides.

---

## Meeting

A single session of a Committee on a specific date.

A Meeting produces Documents: an agenda, attachments, and eventually minutes. Its status reflects whether minutes have been published yet.

Example: Local Transport Forum, 18 May 2026.

---

## Document

A source file the system has fetched and tracked.

Types: agenda HTML, minutes HTML, attachment HTML, attachment PDF, embedded image.

Documents are tracked so the system knows what has been ingested and can detect when new ones appear. HTML is preferred over PDF when both are available.

---

## Topic

A real-world issue that residents follow.

A Topic has a lifespan that may span multiple meetings and months or years. Its current status reflects where the issue stands in the real world right now — not what was on any particular agenda.

Examples: "New raised crossing — Illawarra Rd at Wharf St", "Speed limit drop — Rozelle, Lilyfield, Ashfield, Haberfield".

A Topic has a type (crossing, parking, speed, latm, event, etc.), one or more suburbs, one or more streets, and a list of linked Agenda Items.

---

## Decision

A single appearance of a Topic at a specific Meeting — what was decided that day.

One Topic may have many Decisions over time as it is discussed, deferred, amended, and eventually ratified. Carries the resolution text and works start date. A Decision that has not yet been linked to a Topic has a null topicId — it is pending human confirmation.

---

## Entry Point

A way residents navigate into the site.

Current entry points: by suburb, by street. Planned: by Topic (follow an ongoing issue). Entry points are open-ended — new ones will be added as the site grows. The data model must support flexible lookup by any combination of suburb, street, committee, or topic.

---

## Ingestion

The process of fetching a Document from infocouncil.biz, extracting structured data from it, and creating or updating Topics and Agenda Items.

Ingestion is automated (scheduled scans detect new Documents) but may require human confirmation when linking a new Agenda Item to an existing Topic is ambiguous.

---

## Issue Tracker

Open work items are tracked as GitHub Issues at https://github.com/leemcdougall/innerwestwatch/issues.

When starting a new session, run `gh issue list` to see what's open. When work is complete, close the relevant issue. Do not maintain a separate backlog file — GitHub Issues is the single source of truth for outstanding work.

---

## Topic Linking

The process of associating a new Agenda Item with an existing Topic.

The system suggests links based on matching streets, suburbs, and type. A human confirms or rejects the suggestion. Confirmed links are stored; unlinked items remain visible but flagged as pending.
