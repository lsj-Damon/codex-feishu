# Task Plan: Codex Worker Second-Round Enhancements

## Goal
Implement the second-round Codex worker enhancements: automatic broken-session replacement, clearer progress event categorization, and improved operational query ergonomics for jobs with multiple historical Codex runs.

## Current Phase
Complete

## Phases

### Phase 1: Design and Scope
- [x] Inspect current Codex session/progress/run-query implementation
- [x] Clarify desired query priority: operations/debugging visibility first
- [x] Write approved design doc under `docs/plans`
- **Status:** complete

### Phase 2: Broken Session Recovery
- [x] Add replacement-session flow in session manager
- [x] Update worker to retry once with replacement session after resume failure
- [x] Verify session state transitions remain consistent
- **Status:** complete

### Phase 3: Progress Classification
- [x] Expand translated event shape with structured categories
- [x] Classify real Codex event shapes into stable categories
- [x] Expose category in progress logging and downstream handling
- **Status:** complete

### Phase 4: Job/Run Query Ergonomics
- [x] Add repository APIs for latest attempt, latest success, and run summary by job
- [x] Replace ad hoc latest-run lookup in worker
- [x] Align operational queries/runbook wording with new repository semantics
- **Status:** complete

### Phase 5: Verification
- [x] Update or add smoke coverage for replacement-session behavior
- [x] Update streaming smoke coverage for event categories
- [x] Run typecheck/build and targeted smokes
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Prioritize operations/debugging visibility for multi-run jobs | User chose operational clarity over pure DB-layer simplification. |
| Avoid a schema migration in round 2 unless blocked | Current tables already preserve enough audit trail; repository/view improvements are cheaper and safer. |
| Keep historical failed runs visible | They are useful audit history and should not be collapsed away. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| PowerShell `Get-ChildItem -Filter` does not accept an array | 1 | Switched to `-Name` plus `Where-Object` filtering. |
| `FakeCodexCliClient` could not simulate resume failure | 1 | Extended fake client with `waitForCompletionError` support. |
