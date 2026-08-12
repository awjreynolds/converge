# Codex integration surfaces for Converge

Research date: 2026-08-12

## Decision

Use **`codex app-server` over a child process's stdio JSONL transport** for the first Converge adapter. It is the Codex interface explicitly intended to power rich clients, including the official VS Code extension, and it is the only documented surface that combines thread lifecycle, streamed agent/tool/file events, human input, cancellation, and first-class command/file approval requests. [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server)

Keep the first adapter on app-server's non-opt-in API surface, pin and validate the supported Codex CLI range, and generate protocol types from that exact CLI version with `codex app-server generate-ts`. The overall app-server command is still marked experimental and not supported for production workloads, even though its protocol separately gates additional experimental methods behind `capabilities.experimentalApi`; this makes it suitable for Converge's initial open-source vertical slice, not yet a compatibility-free production dependency. [App-server protocol and schema generation](https://learn.chatgpt.com/docs/app-server) · [feature-maturity definitions](https://learn.chatgpt.com/docs/feature-maturity)

## Why this surface fits

| Requirement | App-server capability | Constraint for Converge |
| --- | --- | --- |
| Start or continue work | `thread/start`, `thread/resume`, `thread/list`, and `thread/read`; threads persist to Codex rollout history. | The first slice should start and resume **Converge-owned** threads. Do not promise attachment to a concurrently running thread owned by another Codex process. |
| Inspect and modify a repository | `cwd`, `sandboxPolicy`, and `approvalPolicy` are set on `turn/start`; standard item events cover command execution and file changes. | Pass the single-folder workspace as an absolute `cwd` and explicit sandbox/approval settings on every turn. |
| Observe progress | Notifications cover `thread/*`, `turn/*`, `item/*`, command output deltas, file changes, and aggregated turn diffs. | Treat final `item/completed`/`turn/completed` data as authoritative, not concatenated deltas. |
| Exchange structured Change Units | `turn/start.outputSchema` constrains the final assistant message for that turn. | Use one bounded turn per Converge checkpoint and persist the validated result as a Converge event. Mid-turn `dynamicTools` would be more direct but is experimental; defer it. |
| Discuss or redirect | A later `turn/start` continues the same thread; `turn/steer` can append input to an active turn. | Manual mode should normally wait at a completed-turn boundary. Use `turn/steer` only for live correction, not as the durable Change Unit protocol. |
| Pause/cancel | `turn/interrupt` ends an active turn with `status: "interrupted"`. | A semantic pause is a completed checkpoint turn waiting for human action; interruption is a cancellation mechanism, not approval state. |
| Run verification | An implementation or verification turn can run commands and streams their output/status. | Verification is still subject to the independent Codex sandbox and approval policy. |
| Preserve permission separation | Command and file approvals arrive as server-initiated requests with explicit decisions and `threadId`/`turnId`. | Render these as **Codex execution permission** prompts, never as Converge design approval. |

The lifecycle and event claims above are documented in the [app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview), [turn controls](https://learn.chatgpt.com/docs/app-server#turns), [events](https://learn.chatgpt.com/docs/app-server#events), and [approvals](https://learn.chatgpt.com/docs/app-server#approvals) sections.

## Recommended first-slice protocol

1. **Launch and initialize.** The extension host spawns the configured `codex` executable as `codex app-server --listen stdio://`, parses one JSON-RPC message per stdout line, sends `initialize` with Converge's client identity, then sends `initialized`. Stderr is diagnostics only. The default stdio transport avoids the app-server WebSocket transport, which is explicitly experimental/unsupported and needs extra authentication precautions when non-local. [Transport and initialization](https://learn.chatgpt.com/docs/app-server#protocol)

2. **Discover authentication without owning credentials.** Call `account/read`; reuse Codex-managed ChatGPT or API-key authentication and offer the documented managed login only when needed. Converge must not read or store `auth.json` or externally managed ChatGPT tokens. [App-server authentication modes](https://learn.chatgpt.com/docs/app-server#auth-endpoints)

3. **Create a Converge-owned thread.** Call `thread/start` with the workspace root as `cwd`, a read-only sandbox, and an explicit approval policy. Persist the returned Codex `thread.id` beside the Converge Pairing Session. On extension restart, initialize a new child, reconcile with `thread/read(includeTurns: true)`, then `thread/resume` before starting another turn. [Thread lifecycle](https://learn.chatgpt.com/docs/app-server#threads)

4. **Investigate and propose.** Start a read-only turn whose `outputSchema` is a tagged Converge envelope such as `proposeChange | completeImplementation | blocked`. Validate the final structured message in Converge's adapter, turn it into domain events, and stop. `outputSchema` applies only to the current turn, so send it on every protocol turn. [Structured turn output](https://learn.chatgpt.com/docs/app-server#turns)

5. **Wait for the human in Converge.** Discussion, redirection, rejection, or approval is recorded in Converge first. Discussion/redirection becomes a new read-only Codex turn on the same thread, including the Change Unit identity and human feedback. This supplies a real pause without relying on an undocumented suspended-agent state.

6. **Implement only after design approval.** Start a new turn with `sandboxPolicy: workspaceWrite` scoped to the repository and an explicit `approvalPolicy`. Stream standard command/file/diff events into the UI. Converge design approval only authorizes this state transition; any command, file, network, or permission request from app-server remains a separate server request requiring its own response. App-server documents distinct command/file approval decisions and request lifecycles. [Sandbox controls](https://learn.chatgpt.com/docs/app-server#turns) · [execution approvals](https://learn.chatgpt.com/docs/app-server#approvals)

7. **Verify and report.** Run verification in another bounded turn, preserving the same explicit execution policy, and use an output schema for a structured implementation/test report. Persist standard Codex evidence (commands, exit status, file-change items, final diff) as evidence attached to the Change Unit, rather than treating raw agent prose as proof.

8. **Cancel safely.** Send `turn/interrupt` and wait for `turn/completed` with `interrupted`; if the child process fails, mark the adapter disconnected and reconcile persisted history after restart. [Turn interruption](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn)

## Reconnection and ownership limits

App-server subscriptions are connection-scoped. Starting or resuming a thread subscribes the connection to future events, and `thread/read(includeTurns: true)` supplies a persisted snapshot. The documentation does not expose an event replay cursor or a guarantee that transient notifications missed during a process/connection failure will be replayed. Therefore:

- persist Converge's own event log before advancing its state machine;
- reconcile Codex's completed thread/turn/item snapshot after reconnect;
- make Change Unit commands idempotent with Converge-generated IDs;
- never infer design approval from the Codex transcript or filesystem state;
- scope the first slice to sessions created by Converge, even though stored CLI/VS Code thread sources can be listed;
- treat an active thread in another app-server process as unavailable rather than attempting concurrent ownership.

App-server supports subscription state and a grace period for loaded threads in the same server process, but this does not establish cross-process live attachment. [Thread status and subscriptions](https://learn.chatgpt.com/docs/app-server#track-thread-status-changes)

## Packaging and compatibility

For the first installable VS Code package, require a user-installed Codex CLI and expose a setting for an absolute executable path. On activation:

- run `codex --version` and reject versions outside the tested range with an actionable message;
- spawn the executable directly, never through a shell;
- generate and commit TypeScript protocol bindings from the minimum supported CLI, then validate incoming tagged unions defensively;
- keep unknown notifications non-fatal and surface protocol errors clearly;
- persist only the Codex thread ID and Converge state, not credentials;
- test macOS/Linux/Windows executable discovery separately before claiming those targets.

The generator is intentionally version-specific, so version pinning is part of the adapter contract rather than an implementation detail. OpenAI publishes the CLI and app-server source in [`openai/codex`](https://github.com/openai/codex), while the official IDE extension itself is not open source. [Open-source components](https://learn.chatgpt.com/docs/open-source)

Local verification on the research date used `codex-cli 0.147.0-alpha.6.5`: `codex app-server generate-ts` produced the documented thread/turn/approval request unions. This confirms feasibility against one installed build, not general compatibility.

## Why not the other supported surfaces

- **TypeScript Codex SDK:** it is the closest fallback for Node and supports start/resume, streamed structured execution events, and final JSON-schema output. Its public abstraction wraps `codex exec`, however, and does not document the bidirectional approval, live steering, subscription, and rich-client lifecycle that Converge needs. Use it for automation, not this UI adapter. [Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk) · [SDK source README](https://github.com/openai/codex/tree/main/sdk/typescript)
- **`codex exec --json`:** emits JSONL events, supports a final output schema, explicit sandboxing, and later `resume`, but is documented for non-interactive scripts/CI with pre-set permissions. It is a viable degraded proof-of-concept fallback, not the Manual-mode interaction surface. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- **`codex mcp-server`:** exposes two coarse tools, `codex` and `codex-reply`, and is intended for Agents SDK/multi-agent orchestration. It does not expose app-server's complete rich-client lifecycle as its public contract. [Codex MCP server](https://learn.chatgpt.com/docs/mcp-server)
- **Direct Responses API:** this is not a Codex client integration surface and would make Converge rebuild Codex's repository tools, sandbox, approvals, and persisted thread behavior, contrary to the project's scope.

## Deferred experiment

After the vertical slice works, evaluate app-server `dynamicTools` as a direct mid-turn `propose_change_unit` channel. It can produce typed tool-call arguments and wait for a client response, but OpenAI explicitly gates it behind `experimentalApi`. The stable-first protocol above instead maps one structured final response to one checkpoint, which is simpler to test, recover, and replace across future agent adapters. [Dynamic tool calls](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)
