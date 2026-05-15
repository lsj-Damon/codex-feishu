---
title: "Feishu Codex Round 2 Enhancements Design"
date: "2026-05-15"
updated: "2026-05-15"
project: "feishu-server"
type: "technical-report"
status: "active"
version: "1.0"
tags: ["feishu-server", "codex", "session-manager", "progress", "operations"]
changelog:
  - version: "1.0"
    date: "2026-05-15"
    changes:
      - "Add automatic broken-session replacement"
      - "Add structured Codex progress categories"
      - "Add job-centric Codex run summary queries"
related:
  - "docs/plans/2026-05-14-feishu-codex-cli-session-manager-design.md"
---

## Scope

This round extends the Codex-backed worker in three targeted areas:

- automatically replace broken Codex sessions instead of leaving recovery to the next manual action
- classify progress events into clearer operational categories
- improve job-centric run visibility while preserving all historical attempts

No schema migration is planned in this round unless implementation reveals a hard blocker.

## Goals

- A session that is already marked `broken` must never be resumed again.
- A resume failure should create a replacement session for the same conversation and project.
- Progress logs and callbacks should carry structured categories instead of free-form progress only.
- Code that needs job/run state should stop using ad hoc SQL and use repository-level summary methods.

## Non-Goals

- rewriting Feishu message formatting for each progress category
- removing historical failed runs
- introducing a new reporting table or attempt-grouping schema

## Recommended Changes

### 1. Broken-session replacement

- `CodexSessionManager.ensureSessionForProject()` will stop reactivating a `broken` session.
- A new replacement-session flow will create a fresh session for the same conversation and project while preserving the broken session as history.
- The worker will attempt one in-process recovery when a resumed session appears unusable.

Recommended detection rules:

- prefer replacement when a resumed run fails before producing meaningful stream events
- keep the replacement attempt capped at one per user message

### 2. Structured progress categories

`CodexTranslatedEvent` will be extended with a stable `category` field.

Recommended categories:

- `session`
- `turn`
- `status`
- `tool`
- `command`
- `warning`
- `final`

These categories are primarily for logging, throttling, and future observability. Feishu output can remain text-first.

### 3. Job-centric run summary APIs

`CodexRunRepository` will add job-oriented queries:

- latest attempt by job
- active attempt by job
- latest finished attempt by job
- latest successful attempt by job
- full attempt list by job
- consolidated run summary by job

The worker will consume the summary API instead of issuing raw `ORDER BY id DESC` queries.

## Worker Flow Changes

For a normal Codex execution:

1. Resolve a usable session for the bound project.
2. Create and persist a run attempt.
3. Execute Codex, persist stream events, and classify progress categories.
4. If the resumed session fails in a way that looks session-specific:
   - mark the old session `broken`
   - persist the failed run
   - create a replacement session
   - create a new run attempt for the same job
   - retry once with the replacement session
5. Return the final successful run to normal delivery flow.

## Operational Visibility

Historical runs remain intact. Repository summaries will make it easy to answer:

- which run is currently active for this job
- which run most recently finished
- which run most recently succeeded
- how many failed attempts exist in history

This keeps audit value while making live debugging less ambiguous.

## Verification Plan

- extend session-manager smoke coverage for replacement-session behavior
- extend streaming smoke coverage for progress categories
- extend worker smoke coverage for resume-failure replacement and multi-run summaries
- run `typecheck`, `build`, and targeted Codex smoke scripts
