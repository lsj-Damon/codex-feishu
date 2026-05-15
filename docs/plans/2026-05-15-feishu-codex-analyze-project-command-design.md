---
title: "Feishu Codex Analyze Project Command Design"
date: "2026-05-15"
updated: "2026-05-15"
project: "feishu-server"
type: "technical-report"
status: "active"
version: "1.0"
tags: ["feishu-server", "codex", "commands"]
changelog:
  - version: "1.0"
    date: "2026-05-15"
    changes:
      - "Add 分析项目 control command aliasing to /understand --language zh"
related:
  - "docs/plans/2026-05-15-feishu-codex-round2-enhancements-design.md"
---

## Scope

Add a new Feishu control command:

- `分析项目`

When received, the worker should not answer locally. It should rewrite the effective Codex input to:

- `/understand --language zh`

and then run the normal Codex execution path for the currently bound project.

## Design

- Extend `CodexControlCommand` with `analyze_project`.
- Parse exact input `分析项目`.
- Keep existing local-only behavior for:
  - `项目列表`
  - `当前项目`
  - `切换项目 <name>`
  - `新建项目 <name>`
- Treat `分析项目` as a Codex command alias:
  - do not send a local assistant reply
  - override the effective user text passed into `executeCodexJob()`
  - preserve normal session reuse, progress delivery, retry, and final delivery logic

## Safety

- If the conversation has no bound project, keep the current binding logic and execution path unchanged.
- This command introduces no schema changes.

## Verification

- Extend control-command smoke coverage to ensure `分析项目` is not handled as a local-only reply.
- Extend worker smoke coverage to verify the rewritten Codex input is `/understand --language zh`.
