# ADR 0001 — /api/items street filter: multiple values, no radius search

**Status:** Accepted  
**Date:** 2026-06-08

## Decision

The `/api/items` Worker endpoint accepts multiple `street` values in a single request (e.g. `?street=Edwin+St&street=Tramway+St`). Suburb and street are treated as independent filters — suburb is a civic/interest filter, street is a physical-proximity filter. They are not interchangeable.

## Why

Residents think about "streets near me" geographically, not by suburb boundary. A resident on the Tempe/Marrickville border cares about what's happening on their neighbouring streets regardless of which suburb those streets fall in. Suburb filters alone cannot serve this use case.

## What we did not do — and why

We did not implement radius-based search (e.g. "show me everything within 500m of my location"). That would require storing coordinates for every street and running geospatial queries. This is a meaningfully larger project — new data, new infrastructure, new frontend — and was out of scope for Milestone 1.

## Future path

If the "streets near me" use case grows in importance, the next step is to attach lat/lng coordinates to each street in the Topic/AgendaItem data model and add a radius query to the Worker. This is a discrete, well-understood project that does not require changing the existing filter contract — it would be an additive new query parameter (e.g. `?near=lat,lng&radius=500`).

## Alternatives considered

- **Suburb as proxy for neighbourhood:** rejected — suburb boundaries are administrative, not geographic. They do not reliably capture what residents mean by "near me."
- **Single street value only:** rejected — too limiting for residents who want to monitor a few neighbouring streets without making separate requests.
