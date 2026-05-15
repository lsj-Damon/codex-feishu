# Findings: Codex Worker Second-Round Enhancements

## Current Findings
- `CodexSessionManager.ensureSessionForProject()` previously reused the latest project session even when it had become `broken`; there was no replacement-session concept.
- The worker previously marked a session `broken` on generation/resume failures, but did not automatically create a replacement session and continue the same user message.
- `CodexTranslatedEvent` previously exposed only `kind`, `text`, and `eventType`; all user-visible progress semantics were flattened into plain text.
- Real Codex JSONL samples are dominated by `thread.started`, `turn.started`, `turn.completed`, `item.started`, and `item.completed`.
- The most useful real subtypes inside `item.*` are `agent_message`, `mcp_tool_call`, and `command_execution`.
- Worker-side multi-run handling was previously ad hoc: `findLatestRunIdForJob()` did a raw SQL `ORDER BY id DESC LIMIT 1`, which could not distinguish active/latest-success/history-summary semantics.
- The repository layer previously exposed only `getById()` and `getLatestBySessionId()` for Codex runs; there was no job-centric run summary API.

## Implemented Design Direction
- Broken sessions are now treated as terminal for resume purposes and automatically replaced with a fresh session bound to the same conversation/project.
- The worker now retries once in-process with a replacement session when a resumed session fails in a session-specific way.
- Progress events now carry a stable `category` field for logging and downstream handling.
- The current category set is:
  - `session`
  - `turn`
  - `status`
  - `reasoning`
  - `tool`
  - `command`
  - `warning`
  - `final`
- `CodexRunRepository` now exposes job-centric read models:
  - active run by job
  - latest attempt by job
  - latest finished run by job
  - latest successful run by job
  - consolidated job history summary

## Verification Findings
- `typecheck` passes.
- `build` passes.
- `smoke:codex-session-manager` now covers broken-session replacement.
- `smoke:codex-streaming` now covers delivered progress categories.
- `smoke:codex-worker` now covers resume failure followed by automatic replacement-session recovery and multi-run summary semantics.
