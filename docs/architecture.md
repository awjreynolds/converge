# Architecture

Converge is organized around four explicit seams. Tests and callers use the same public interfaces.

## Pairing Session core

`@converge/core` is IDE- and provider-independent. It owns the Pairing Session state machine, stable Change Unit identities and revisions, human feedback, evidence, verification, and the Understanding Check. State transitions are deterministic when supplied with an identity source and clock.

The core never imports `vscode`, starts processes, reads provider credentials, or treats chat messages as durable state.

## Agent adapter

The core's `AgentPort` accepts bounded phase requests and emits structured events. `@converge/codex` implements that interface with `codex app-server` over stdio JSON-RPC; `@converge/claude` implements the same interface over the Claude Agent SDK. Provider protocol types remain inside their adapter packages.

Each investigation, discussion, revision, implementation, verification, summary, or understanding-assessment checkpoint is a bounded provider turn. The active adapter validates the completed structured output before it becomes Converge state. Experimental dynamic tools and cross-process live attachment are not part of this slice.

## Persistence

Pairing Session persistence satisfies `PairingSessionStore`. The first adapter writes transparent repository-local JSON beneath `.converge/`. State is saved after each accepted transition so extension restart does not make the chat transcript or current filesystem the source of truth.

Each session persists one grouped agent identity: a stable provider ID and an optional provider conversation ID. Legacy sessions migrate to the default Codex identity on read. A session cannot resume through a different provider. Credentials and execution approvals are not persisted.

## VS Code host

The desktop extension host is a thin adapter around the core:

- a Webview View renders plain snapshots and sends validated actions;
- Mermaid is bundled locally and rendered under a strict content-security policy;
- immutable baseline content and live files are opened with VS Code's native diff command;
- workspace trust gates agent and execution actions;
- VS Code objects never cross into the core or webview protocol.

The webview can be discarded and rehydrated. Durable Pairing Session state lives outside the iframe.

The extension registry validates the selected provider before a new session is persisted. Codex
checks its configured executable and app-server version. Claude checks provider-owned API/cloud
configuration and the exact configured local Claude Code version; neither check sends workspace
content to a provider.

## Approval boundaries

Two approvals must never be conflated:

1. **Converge design approval** advances a Change Unit from proposed direction toward implementation.
2. **Provider execution approval** grants or denies a specific command, file, network, or other capability request according to the active provider's sandbox and policy.

Approving a Change Unit does not automatically answer an execution approval request.
