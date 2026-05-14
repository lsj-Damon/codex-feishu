# Findings: Feishu-server Architecture Analysis

## Current Structural Findings
- The project is a two-process local service: `bot-gateway` receives Feishu events and persists/enqueues work; `assistant-worker` leases jobs, calls the LLM path, and sends replies back to Feishu.
- Both processes share a single SQLite database opened via Node 24 `node:sqlite`, with `WAL` mode enabled and migrations applied from the local `migrations/` directory on startup.
- Startup for both roles follows the same pattern: load layered config, ensure runtime directories, acquire a single-instance lock, open DB, run migrations, start service, and publish health state.
- The gateway is responsible for trigger filtering, deduplication, conversation/message persistence, attachment metadata persistence, and job creation.
- The worker is responsible for job leasing, lease renewal/recovery, context building, OpenAI call execution, delivery persistence, Feishu reply delivery, retry scheduling, and summary refresh.

## Flow Findings So Far
- Ingress is pluggable between Feishu websocket and webhook modes through `FeishuLongConnection`; the application-level handler path is the same after dispatch.
- Incoming Feishu events are normalized into a `NormalizedInboundMessage` structure; unsupported events, bot-originated events, and non-supported chat types are dropped before persistence.
- Group chats are gated by trigger policy and require a bot mention unless group handling is disabled entirely.
- Message ingestion is transactional: raw event dedupe, conversation get-or-create, user message insert, attachment persistence, and job enqueue happen inside one DB transaction.
- Worker processing distinguishes generation failures from delivery failures, and preserves generated assistant messages across delivery retries.
- The OpenAI client uses Responses API with optional `previous_response_id` continuation and local fallback to explicit context messages when continuation fails.
- A single-image MVP exists: the worker loads at most the first image attachment, downloads it from Feishu, converts it to a data URL, and attaches it as `input_image` to the latest user turn.

## Codex CLI Assessment Direction
- The current architecture is not a natural drop-in "Codex CLI backend" yet; it is designed as a Feishu chat assistant with OpenAI Responses as the reasoning/execution engine.
- The likely integration seam is the worker's model-execution boundary, not the gateway.
- There are at least three candidate integration patterns to evaluate next: keep OpenAI path and expose Codex separately, replace LLM call with Codex CLI subprocess execution, or add Codex CLI as a selective execution mode/tool path.

## Final Conclusions
- The core execution path is split cleanly into a synchronous ingress process (`bot-gateway`) and an asynchronous execution/delivery process (`assistant-worker`), with SQLite acting as the durability and coordination boundary.
- The design is operationally stronger than a single-process bot because it isolates delivery retry from generation retry and can recover expired worker leases.
- The current product shape is an IM coding assistant, not a repository-operating coding agent; this matters directly for Codex CLI integration scope.
- Codex CLI integration is feasible if introduced as an explicit worker backend mode with workspace mapping and persisted session ids.
- A full replacement of the OpenAI path with Codex CLI would be materially riskier because it would pull repository selection, tool safety, and worktree management into a system that does not currently model them.
- The architecture report was written to `D:\\Develop\\workspace\\feishu-server\\feishu-server-architecture-report.md`.

## Current Implementation Findings
- Step 1 has been started with a dedicated design doc under `docs/plans/2026-05-14-feishu-codex-cli-session-manager-design.md`.
- The initial schema expansion is centered in `0004_codex_sessions.sql`, which adds conversation project binding plus `codex_sessions`, `codex_runs`, and `codex_stream_events`.
- Config now explicitly models a `codex` section instead of overloading the existing `openai` section for workspace and CLI concerns.

## Completed PoC Findings
- Worker-side control commands now support project listing, current-project inspection, project switching, and project creation within the configured Codex workspace root.
- The worker now routes ordinary messages through a Codex session/run pipeline instead of the OpenAI generation path.
- Codex session lifecycle is persisted with reusable `codex_session_id` (`thread_id`) support.
- Codex JSON event streaming is captured, translated, and emitted as multiple Feishu progress messages before the final reply.
- Real Codex CLI integration in this environment requires tolerant parsing because stdout/stderr are polluted with non-JSON anomaly lines.
- The current production-safe assumption is still one conversation at a time per active session; richer cancellation and multi-run concurrency control remain future work.
