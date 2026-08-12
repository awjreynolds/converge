# Pi provider integration decision

## Decision

Integrate Pi as a local external process through its documented JSONL RPC mode. Converge supports
exactly Pi CLI `0.84.1` for this first vertical slice.

Pi also publishes an official TypeScript SDK, but the current SDK requires Node.js 22.19 or newer.
The minimum supported VS Code 1.95 extension host uses Node.js 20. Running the SDK in-process would
therefore violate Pi's engine contract or require dropping Converge's supported VS Code baseline.
The RPC boundary lets the user-installed `pi` executable own its compatible Node runtime, model
selection, provider authentication, and session storage. It also isolates process failure and avoids
bundling Pi's approximately 13.6 MB SDK package and provider dependency tree into the VSIX.

The older `legacy-node20` SDK distribution was rejected because it intentionally lags Pi's current
public protocol and compatibility fixes.

## Safety boundary

Converge starts Pi without a shell and disables discovered extensions, skills, prompt templates,
themes, context files, and project trust. It then loads only Converge's packaged gate extension and
an explicit tool allowlist.

The gate permits read-only tools directly. `bash`, `edit`, and `write` block before execution until
Converge receives and answers a separate execution-approval request. Unknown tools and unknown Pi
extension UI requests are denied. The structured phase result is returned through one terminating
`converge_result` tool and decoded by the same provider-neutral core decoder used by Codex and
Claude. Thinking deltas are never shown or persisted as progress.

Pi does not provide a filesystem, shell, or network sandbox. Approval is an authority checkpoint,
not isolation; shell-created network traffic requires an external sandbox or egress boundary.

## Compatibility and validation

Before a Pairing Session is persisted or workspace content is sent, Converge:

1. verifies the configured executable reports exactly `0.84.1`;
2. starts a restricted ephemeral RPC process with no session, tools, or discovered resources;
3. reads Pi's selected model and available authenticated model set without issuing a prompt; and
4. fails with setup guidance if the selected model is unavailable.

Converge never reads, copies, stores, or refreshes Pi credentials. Engineers authenticate and select
models using Pi itself.

## Protocol policy

- Parse strict LF-delimited JSON records; generic line readers are not protocol compliant because
  Unicode line separators are valid inside JSON strings.
- Persist Pi's full session ID as the provider-neutral conversation identity and resume with
  `--session`. Never use `--session-id`, which may create a missing session instead of failing.
- Treat `agent_settled`, rather than the lower-level `agent_end`, as turn completion.
- Latch cancellation before process startup, deny pending approvals, request `abort`, and terminate
  a non-responsive process after a bounded grace period.
- Pin deterministic fixtures at the public RPC/transport boundary. Required CI never contacts a
  live model provider or sends repository content outside the disposable test workspace.

## Sources

- [Pi SDK](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/sdk.md)
- [Pi RPC protocol](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/rpc.md)
- [Pi extension contract](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/extensions/types.ts)
- [Pi CLI arguments](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/cli/args.ts)

