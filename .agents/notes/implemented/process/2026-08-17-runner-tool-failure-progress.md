# Agent Note: Runner tool failure progress summaries

Status: implemented

English | [中文](2026-08-17-runner-tool-failure-progress.zh.md)

## Problem

The runner reported that a tool started and later finished, but its stderr progress stream did not say whether the tool result was an error or expose the short failure reason. A caller supervising a long task therefore could not distinguish recovery from repeated tool failure until the child produced its final response. When the final `turn/end` carried `reason.kind: "error"`, the runner returned a failed status and stop reason but omitted the provider error details from `RunnerResult.error`.

## Decision

The runner maps failed `tool/result` session events to an `activity` progress record with `message: "<tool> failed"`, `toolName`, and a bounded `toolError` summary. The summary keeps the event's error name and code when present, extracts only the first textual error content, normalizes control whitespace, redacts account, user, tenant, and request identifiers, and limits the result to 240 characters. Tool-call correlation is scoped by session id and call id; the call id is not emitted.

Successful tool results keep the existing `"<tool> finished"` progress message. Task text, tool arguments, full tool-result content, and model messages remain outside the progress stream.

When the final child `turn/end` carries `reason.kind: "error"`, the runner maps its error to `RunnerResult.error` with `name: "ChildTurnError"`, the bounded and redacted message, and the provider code when present. Transport, timeout, cancellation, and teardown failures keep their existing runner-owned error names.

## Alternatives considered

**Forward the complete `tool/result` event.** This would expose tool output and call metadata that callers do not need for supervision and could leak file contents or credentials. The bounded summary preserves the recovery signal without turning progress into a transcript.

**Wait for the final assistant response.** This leaves a long-running caller blind while the child retries or changes tools, which is the failure mode this record addresses.

**Expose only the final stop reason.** The value `"error"` identifies termination but cannot distinguish a provider subscription failure from another model request failure. Preserving the bounded provider message and code lets the caller classify the outcome without reading private session storage.

**Add the failure to the SDK wire protocol.** The existing session event already carries the failure; the missing behavior is a runner presentation concern, so changing the shared protocol would widen the surface without helping non-runner consumers.

## Consequences

Callers can display or automate on a structured tool failure while the child remains active and can classify a settled model failure from the final JSON result. These summaries are diagnostic rather than complete error records: callers that need full replay must inspect the persisted session, and future error content remains subject to the fixed length limit.
