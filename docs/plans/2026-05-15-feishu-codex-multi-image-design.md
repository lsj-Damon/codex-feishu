---
title: "Feishu Codex Multi-Image Design"
date: "2026-05-15"
updated: "2026-05-15"
project: "feishu-server"
type: "technical-report"
status: "active"
version: "1.0"
tags: ["feishu-server", "codex", "feishu", "images", "multi-image"]
changelog:
  - version: "1.0"
    date: "2026-05-15"
    changes:
      - "Define same-message multi-image support for the Codex-backed Feishu worker path"
related:
  - "docs/plans/2026-05-15-feishu-codex-image-continuation-design.md"
  - "docs/plans/2026-05-14-feishu-codex-cli-session-manager-design.md"
---

## Scope

Extend the current Codex-backed Feishu image continuation flow from single-image support to multi-image support for a single triggering Feishu message.

This round only covers:

- multiple images attached to the same Feishu message
- a maximum of 9 images attached to one Codex turn
- both new-session and resume-session Codex execution

This round does not cover:

- collecting images across multiple Feishu messages
- image stitching or composite-image generation
- OCR-specific preprocessing

## Goal

- preserve the current Codex session behavior
- attach up to 9 images from the current Feishu message in attachment order
- tolerate partial download failure
- make attachment state observable in the database and logs

## Current Baseline

The current worker path already supports:

- image attachment metadata persisted by the gateway
- local image download for the triggering message
- `imagePaths: string[]` in the Codex client interface
- repeated `-i <path>` injection into `codex exec` and `codex exec resume`

The main remaining limitation is in the worker selection policy:

- `prepareTriggerImages()` currently selects only the first image attachment

Because the downstream Codex client is already array-based, the multi-image change is concentrated in worker selection, attachment status handling, and prompt text.

## Recommended Approach

### Option A: Expand the current worker path and add `skipped` status

Recommended.

Keep the existing architecture and change only the attachment preparation stage:

- sort all image attachments by `attachment_index`
- process at most 9 images
- pass every successfully prepared local file path into the current Codex run
- mark attachments beyond the 9-image cap as `skipped`

Why this is recommended:

- minimal blast radius
- keeps current resume/new-session behavior intact
- preserves per-image observability
- leaves a clean path to future cross-message aggregation

### Option B: Expand to 9 images without adding `skipped`

Simpler schema impact, but not recommended.

Attachments above the cap would simply be ignored. This makes support and debugging worse because the database cannot distinguish:

- image download failure
- policy-driven omission

### Option C: Merge images into one local composite before Codex

Not recommended for the first expansion.

This reduces the number of `-i` arguments but changes semantics. It can hide detail, break ordering assumptions, and makes troubleshooting harder.

## Data Model Changes

### Attachment status

Current attachment status values are:

- `pending`
- `downloaded`
- `failed`

Add:

- `skipped`

Recommended meaning:

- `pending`: not processed yet
- `downloaded`: downloaded and validated successfully
- `failed`: attempted but unusable
- `skipped`: intentionally not attempted because of policy

Examples of `last_error_message` values for skipped attachments:

- `skipped_by_policy:max_images_exceeded`
- `skipped_by_policy:unsupported_image_type`

No new table is required. The existing `message_attachments` table is sufficient.

## Worker Design

### Selection policy

`prepareTriggerImages()` should change from first-image selection to ordered batch preparation.

Behavior:

1. Load all `image` attachments for the triggering message.
2. Sort by `attachment_index`.
3. Split into:
   - `selected`: first 9 images
   - `overflow`: remaining images
4. Mark all overflow attachments as `skipped`.
5. Attempt to prepare every selected attachment independently.
6. Return all successfully prepared local paths in order.

### Return contract

Replace the current single-image-oriented result with a batch-oriented result:

- `imagePaths: string[]`
- `imageAttachmentReady: boolean`
- `downloadedCount: number`
- `failedCount: number`
- `skippedCount: number`
- `warning: string | null`

Recommended semantics:

- `imageAttachmentReady = imagePaths.length > 0`
- `warning = null` when all selected images succeeded
- `warning` contains an aggregate summary when any selected image failed or any overflow image was skipped

### Download and cache behavior

For each selected attachment:

- if status is `downloaded` and the cached file is still valid, reuse it
- otherwise download from Feishu with `messageResource.get`
- validate the local file as a supported image
- on success, mark `downloaded`
- on failure, mark `failed`

Each image is processed independently. One failed image must not block the remaining images.

## Codex Invocation

No protocol change is required in the Codex client layer.

The current path already supports:

- `imagePaths` arrays in `runNewSession()`
- `imagePaths` arrays in `resumeSession()`
- repeated `--imagePath` arguments in the launcher
- repeated `-i <path>` expansion in the final `codex exec` command

The multi-image work should therefore remain concentrated in the worker.

## Prompt Design

The worker prompt should become image-count aware.

### Full success

When all selected images are attached successfully:

- state how many screenshots are attached
- state that they are available in attachment order
- instruct Codex to compare them when relevant

Example intent:

`The current user message includes 4 screenshot attachments from Feishu, and all 4 screenshots have been downloaded successfully and attached to this turn. The screenshots are attached in the same order as the original message.`

### Partial success

When some selected images fail:

- state the total selected count
- state how many were attached successfully
- state how many were unavailable
- instruct Codex to analyze only the attached images

### Overflow

When the user attached more than 9 images:

- explicitly say that only the first 9 were attached
- preserve attachment-order semantics in the wording

### Image-only message

If the current text is only `[feishu:image]`, add a stronger instruction that the screenshots may show:

- different execution steps
- before/after comparisons
- multiple related errors

This prevents Codex from over-indexing on the first image.

## Error Handling

### Partial failure

If 9 selected images produce:

- 7 successes
- 2 failures

the Codex run still proceeds with 7 images.

### Total failure

If all selected images fail:

- no `imagePaths` are passed to Codex
- the worker falls back to text-only execution
- the prompt includes a warning summary

### Overflow images

Overflow images are not failures. They should not use `failed` status unless an actual attempt was made.

## Observability

The logs should make multi-image handling easy to inspect.

Recommended worker log fields around image preparation:

- `message_id`
- `attachment_count`
- `selected_count`
- `downloaded_count`
- `failed_count`
- `skipped_count`
- `image_keys`

This does not require new log infrastructure, only richer log payloads.

## Testing Plan

Extend the current targeted smoke coverage.

### Required scenarios

1. Same message with 3 images:
   - all 3 succeed
   - Codex receives 3 `imagePaths`

2. Same message with 12 images:
   - first 9 selected
   - last 3 marked `skipped`
   - Codex receives 9 `imagePaths`

3. Same message with partial failure:
   - selected images include at least one failure
   - remaining successful images still go to Codex

4. Same message with total failure:
   - all selected images fail
   - Codex receives zero image paths
   - prompt includes aggregate warning text

5. Resume-session path with multiple images:
   - existing Codex session is reused
   - all successful image paths are passed to `resumeSession()`

### Existing scripts to extend

- `src/scripts/image-mvp-smoke.ts`
- `src/scripts/codex-worker-smoke.ts`

## Rollout Notes

This is a narrow worker-focused change. It should not require:

- gateway contract changes
- Codex launcher protocol changes
- session-manager changes

The migration impact is limited to the attachment status vocabulary.

## Future Extension Path

This design intentionally keeps the public worker-side contract array-based so a later expansion to cross-message image aggregation can reuse the same downstream execution path.

The likely next-step extension would be:

- gather images from the latest N user messages in the same conversation window
- apply a separate per-turn cap
- reuse the same attachment preparation and prompt-summary logic

## Conclusion

The safest multi-image expansion is to preserve the current Codex execution model and upgrade only the message-scoped attachment preparation logic.

The key design points are:

- first 9 images only
- preserve message attachment order
- add `skipped` to distinguish policy omission from real failure
- continue on partial success
- keep the Codex client and launcher unchanged
