---
title: "Feishu Codex CLI Session Manager Design"
date: "2026-05-14"
updated: "2026-05-14"
project: "feishu-server"
type: "technical-report"
status: "active"
version: "1.0"
tags: ["feishu-server", "codex", "session-manager", "design"]
changelog:
  - version: "1.0"
    date: "2026-05-14"
    changes: ["Initial Codex CLI session-manager PoC design"]
related: []
---

## Scope

This design defines a Codex CLI-backed execution mode for the Feishu local coding assistant with these constraints:

- All normal Feishu messages are handled by Codex CLI.
- Workspace scope is restricted to `D:\Develop\workspace`.
- A Feishu conversation binds to one current project and one active Codex session.
- Explicit project switching uses the command `切换项目 <name>`.
- Explicit project creation uses the command `新建项目 <name>`.
- The system must send multiple incremental progress messages back to Feishu while Codex is running.

## Recommended Architecture

- Keep the existing two-process design:
  - `bot-gateway` for Feishu ingress and queueing
  - `assistant-worker` for execution and delivery
- Replace the worker's primary OpenAI path with a Codex-session orchestration path.
- Add a `CodexSessionManager` that owns:
  - project discovery and switching
  - session lifecycle
  - run lifecycle
  - stream-event persistence
  - progress publication

## Core Model

### Conversation binding

Each conversation stores:

- `workspace_root`
- `current_project_name`
- `current_project_path`
- `active_session_id`
- `active_backend`
- `last_switch_at`

### Codex session

Each historical project binding is represented by `codex_sessions`.

Statuses:

- `active`
- `idle`
- `busy`
- `broken`
- `archived`

### Codex run

Each normal user message creates one `codex_runs` row.

Statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `timeout`

### Stream events

Raw Codex JSONL output is persisted in `codex_stream_events`, then translated into user-visible Feishu progress messages.

## Control Commands

- `项目列表`
- `当前项目`
- `切换项目 <name>`
- `新建项目 <name>`

All project targets are restricted to first-level directories under `D:\Develop\workspace`.

## Streaming Strategy

- Send one initial "execution started" message.
- Buffer and coalesce internal Codex events.
- Send incremental progress messages at a bounded rate.
- Always send one final summary message.

## Safety and Constraints

- Do not allow paths outside `D:\Develop\workspace`.
- Do not allow project switching while the current session is `busy`.
- Do not resume a `broken` session; create a replacement session instead.
- Keep all Codex run logs and event files on disk for audit and debugging.
