# Agent Note: Remove echoed DSML tool-call sentinels from pi-ai text streams

Status: implemented

English | [中文](2026-08-17-pi-ai-dsml-tool-call-sentinel.zh.md)

## Problem

Some OpenAI-compatible gateways return a structured function call and also echo the DeepSeek closing tool-call sentinel `</｜DSML｜tool_calls>` as ordinary output text. The Harness stores both event types, so the sentinel appeared in Web assistant messages even though the tool call itself was parsed correctly. Streaming splits the sentinel across deltas, so a complete-string replacement at the session or Web layer cannot prevent the intermediate text from being emitted.

## Decision

`llm-pi-ai` removes only the exact closing sentinel from text conversion. The stream converter keeps a suffix only while it can be a prefix of that sentinel, emits all other text immediately, and drops whitespace following a complete sentinel. The text-block completion applies the same exact removal to the provider's final text. An incomplete or similar-looking string remains unchanged.

## Alternatives considered

**Filter the Web projection.** Rejected because the invalid text would remain in the durable session and other consumers would still receive it.

**Switch every custom route to `openai-completions`.** Rejected because the live probe showed the configured endpoint can return structured tool calls through both supported protocols; protocol selection is deployment-specific and does not establish ownership of the echoed text.

**Buffer each complete assistant text block.** Rejected because it would remove ordinary text streaming for every provider response. The suffix-only state keeps the normal path streaming while covering a sentinel split across events.

## Consequences

The provider adapter owns removal of a provider-wire artifact before it reaches session assembly, Web projection, or other consumers. Only the exact closing sentinel and whitespace immediately after it are removed; user text that merely resembles an incomplete sentinel is preserved. The adapter does not infer or rewrite any other DSML syntax.

## Testing

`packages/llm/llm-pi-ai/tests/convert.spec.ts` covers a sentinel split across three text deltas, preservation of ordinary text streaming, and preservation of an incomplete sentinel. A live, credential-redacted probe against `deepseek-v4-flash-ga-260731` confirmed that both `openai-responses` and `openai-completions` can return a structured tool call; it did not use protocol switching as the fix. Full Web reproduction remains provider-output dependent and is not a deterministic test fixture.
