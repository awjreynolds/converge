# Converge

> Understand AI-generated code while it is being built, not after it is finished.

Converge is an open-source pair-programming and comprehension harness for AI coding agents. Its first client is a VS Code extension that presents meaningful implementation decisions as Change Units with concise rationale, optional Mermaid diagrams, native diffs, human feedback, verification evidence, and a final Understanding Check.

Converge is not a general-purpose coding agent, Pull Request review system, specification framework, editor, or language server. It integrates with a selected local coding-agent provider and leaves code editing, diagnostics, testing, terminals, Git, and diffs in VS Code.

## Status

This repository contains the initial vertical slice. It is intentionally narrow:

- one engineer in one trusted, local, single-folder Git workspace;
- Manual mode;
- three production `AgentPort` adapters: Codex app-server, Claude Agent SDK, and Pi RPC;
- repository-local session state;
- a VS Code Reasoning Panel;
- a deterministic revoked-session demonstration fixture;
- no hosted service, team workflow, Marketplace publication, custom diff, or custom language server.

Codex remains the default for existing installations. Each adapter pins a tested provider version and isolates its provider-specific protocol behind the same core port.

## Requirements

- Node.js 22 or newer
- npm
- desktop VS Code 1.95 or newer
- one supported local agent: Codex CLI, Claude Code 2.1.228 with provider-owned API/cloud authentication, or Pi CLI 0.84.1 with a model authenticated and selected in Pi

## Develop

```bash
npm ci
npm run verify
```

Press `F5` from the repository in VS Code to launch an Extension Development Host, or build an installable package:

```bash
npm run package:vscode
code --install-extension clients/vscode/converge-vscode-0.1.0.vsix
```

In the target workspace, select `converge.provider` (`codex` by default), then run **Converge: Start Pairing Session** from the Command Palette or open the Converge activity-bar view. Configure the selected provider's executable-path setting when it is not on VS Code's process path. Converge validates the supported executable version and provider-owned authentication before creating a session; it never asks for or stores provider credentials.

- Codex uses the account already configured by `codex login`.
- Direct Claude access requires `ANTHROPIC_API_KEY`.
- Claude on Bedrock requires `AWS_BEARER_TOKEN_BEDROCK`, or both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- Claude on Vertex requires `GOOGLE_APPLICATION_CREDENTIALS`.
- Claude on Foundry requires `ANTHROPIC_FOUNDRY_API_KEY` or `ANTHROPIC_FOUNDRY_AUTH_TOKEN`.
- Pi uses the model and credentials already configured in Pi. Install `@earendil-works/pi-coding-agent@0.84.1`, authenticate with Pi, and set `converge.piPath` if needed.

Set only one Claude cloud selector. Because checking ambient cloud identity would require a provider call, Converge deliberately requires explicit provider-owned credentials and fails before reading workspace content when they are absent.

## Demonstration

The repository includes [`fixtures/revoked-session`](fixtures/revoked-session), a tiny TypeScript project with one deliberate defect: a revoked session can still issue a refresh token. Its existing happy-path test passes, but the revoked-session behavior is not yet represented; Converge creates that red test as the first Change Unit.

Follow the [complete walkthrough](docs/walkthrough.md) to exercise investigation, proposal, discussion or redirection, approval, implementation, native diff inspection, verification, and the final Understanding Check.

The same red-to-green journey is executable without a live provider or VS Code. It runs unchanged through the real Codex, Claude, and Pi adapters using deterministic offline transports, edits only a disposable fixture copy, runs the real fixture tests, confirms shared understanding, and removes the copy:

```bash
npm run test:e2e
```

## Architecture

```text
Reasoning Panel (untrusted rendering)
              │ typed JSON actions/snapshots
              ▼
VS Code extension host
              │
              ├── native diff / workspace / trust / storage adapters
              │
              ▼
IDE-independent Converge core
              │ AgentPort
              ├── Codex adapter ── stdio JSON-RPC ── codex CLI
              ├── Claude adapter ── Agent SDK ── local Claude Code CLI
              └── Pi adapter ── JSONL RPC + approval gate ── local pi CLI
```

The core owns Pairing Sessions, Change Units, feedback, lifecycle rules, causal history, verification, and convergence. The VS Code client owns IDE capabilities and explicit provider selection. Each adapter translates provider events into the provider-independent core protocol. Persisted sessions record both the provider ID and that provider's conversation ID, preventing cross-provider resume. See [Architecture](docs/architecture.md).

## Security model

Converge design approval means “I understand and accept this implementation direction.” It does **not** grant filesystem, shell, network, repository, or secret access. Provider execution approval requests remain separate and are labelled as such in the UI.

The first client disables agent execution in untrusted workspaces and does not read or persist provider credentials. Provider executables are spawned directly rather than through a shell. Claude authentication remains owned by Anthropic's SDK environment or supported cloud-provider configuration. Pi owns its selected model and authentication. Converge does not broker provider login.

## Project direction

- [Product specification](docs/specification.md)
- [Domain language](CONTEXT.md)
- [Wayfinder decision map](https://github.com/awjreynolds/converge/issues/1)
- [Contributing](CONTRIBUTING.md)

## License

Converge's source code is [MIT](LICENSE). Optional provider runtimes retain their own licenses and terms. Pi's external CLI is MIT and is not bundled into the VSIX. The Claude Agent SDK is governed by Anthropic's Commercial Terms and is not relicensed by Converge; see the [provider selection report](docs/research/second-provider-selection.md) and [Pi integration decision](docs/research/pi-provider-integration.md).
