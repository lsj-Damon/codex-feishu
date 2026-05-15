---
title: "Feishu Codex Image Continuation Design"
date: "2026-05-15"
updated: "2026-05-15"
project: "feishu-server"
type: "technical-report"
status: "active"
version: "1.0"
tags: ["feishu-server", "codex", "feishu", "images", "continuation"]
changelog:
  - version: "1.0"
    date: "2026-05-15"
    changes:
      - "Define Codex image-attachment flow for Feishu screenshot follow-up turns"
related:
  - "docs/plans/2026-05-14-feishu-codex-cli-session-manager-design.md"
  - "docs/plans/2026-05-15-feishu-codex-round2-enhancements-design.md"
---

## Scope

Add image support to the current Codex-backed worker path so a Feishu user can continue the same Codex session and attach a screenshot from the current run result for diagnosis and code fixes.

This round implements single-image support first, but the execution path remains array-based so multi-image support can be enabled with a narrow follow-up change.

## Goal

- keep the current Codex session whenever possible
- attach the first image from the triggering Feishu message to the current Codex turn
- support both pure image messages and text-plus-image `post` messages
- degrade safely to text-only Codex execution if image download or validation fails

## Non-Goals

- full multi-image UX in this round
- changing Feishu inbound normalization rules beyond what already exists
- reintroducing the old OpenAI Responses generation path as the primary backend

## Recommended Approach

### 1. Preserve current gateway behavior

The gateway already normalizes:

- `image` messages into a `[feishu:image]` placeholder plus one attachment
- `post` messages into extracted text plus zero or more image attachments

No gateway contract change is required for this round.

### 2. Prepare trigger images inside the worker

Before starting a Codex run, the worker will:

- load attachments for the triggering user message
- select up to one image attachment for this round
- download the image if it is still pending or the cached file is unusable
- validate the downloaded file as a supported image
- pass the resulting local file path into the Codex client

The worker interface will remain array-based (`imagePaths: string[]`) so future multi-image support only needs selection-policy changes.

### 3. Attach images to Codex new and resume turns

The Codex launcher and client will accept image file paths and translate them into repeated `-i <file>` arguments for:

- `codex exec`
- `codex exec resume`

This keeps the same session for screenshot follow-up turns instead of forcing a new session when a user sends an image after a development step.

### 4. Prompt behavior

If the latest user message is image-only, the worker prompt should explicitly tell Codex that:

- the user attached a screenshot from Feishu
- the screenshot likely contains runtime output, a UI result, or an error state
- Codex should inspect the screenshot together with the current code and session context

If the latest user message already contains text, the text remains the primary request and the prompt adds a short note that a screenshot is attached.

If image preparation fails completely, the prompt adds a warning that the screenshot could not be downloaded, then continues as a text-only turn.

## Data Flow

1. Feishu message arrives with text, image, or post content.
2. Gateway normalizes and persists the message plus image attachment metadata.
3. Worker leases the job and resolves the current Codex session.
4. Worker prepares up to one image path from the triggering message.
5. Worker launches `codex exec` or `codex exec resume` with the prompt and `-i` image arguments.
6. Progress and final output continue to stream back into Feishu as today.

## Error Handling

- missing attachment metadata: continue without images
- image download failure: mark attachment failed, continue without images
- invalid image bytes: mark attachment failed, continue without images
- resume failure unrelated to image input: keep existing broken-session replacement logic

The worker should never fail the whole Feishu job only because the screenshot could not be attached.

## Verification Plan

- update `smoke:image-mvp` to assert single-image Codex new-session execution
- add or extend smoke coverage for same-session resume with image attachment
- verify fallback behavior when image download fails
- run `build` and targeted smoke scripts
