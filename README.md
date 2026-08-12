# Converge

> Understand AI-generated code while it is being built, not after it is finished.

Converge is an open-source pair-programming and comprehension harness for AI coding agents. Its first client is a VS Code extension that presents meaningful implementation decisions as Change Units with concise rationale, optional Mermaid diagrams, native diffs, human feedback, verification evidence, and a final Understanding Check.

Converge is not a general-purpose coding agent, Pull Request review system, specification framework, editor, or language server. It integrates with an existing Codex CLI and leaves code editing, diagnostics, testing, terminals, Git, and diffs in VS Code.

## Status

This repository contains the initial vertical slice. It is intentionally narrow:

- one engineer in one trusted, local, single-folder Git workspace;
- Manual mode;
- a version-pinned-compatible Codex app-server adapter over stdio;
- repository-local session state;
- a VS Code Reasoning Panel;
- a deterministic revoked-session demonstration fixture;
- no hosted service, team workflow, Marketplace publication, custom diff, or custom language server.

Codex app-server is currently experimental. Converge validates the local CLI version and surfaces protocol failures rather than promising compatibility with every Codex release.

## Requirements

- Node.js 22 or newer
- npm
- desktop VS Code 1.95 or newer
- an installed and authenticated Codex CLI

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

In the target workspace, run **Converge: Start Pairing Session** from the Command Palette or open the Converge activity-bar view. Configure `converge.codexPath` if `codex` is not on VS Code's process path.

## Demonstration

The repository includes [`fixtures/revoked-session`](fixtures/revoked-session), a tiny TypeScript project with one deliberate defect: a revoked session can still issue a refresh token. Its existing happy-path test passes, but the revoked-session behavior is not yet represented; Converge creates that red test as the first Change Unit.

Follow the [complete walkthrough](docs/walkthrough.md) to exercise investigation, proposal, discussion or redirection, approval, implementation, native diff inspection, verification, and the final Understanding Check.

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
              ▼
Codex app-server adapter ── stdio JSON-RPC ── codex CLI
```

The core owns Pairing Sessions, Change Units, feedback, lifecycle rules, causal history, verification, and convergence. The VS Code client owns IDE capabilities. The Codex adapter translates provider events into the provider-independent core protocol. See [Architecture](docs/architecture.md).

## Security model

Converge design approval means “I understand and accept this implementation direction.” It does **not** grant filesystem, shell, network, repository, or secret access. Codex execution approval requests remain separate and are labelled as such in the UI.

The first client disables agent execution in untrusted workspaces, spawns the configured Codex executable directly rather than through a shell, and does not read or persist Codex credentials.

## Project direction

- [Product specification](docs/specification.md)
- [Domain language](CONTEXT.md)
- [Wayfinder decision map](https://github.com/awjreynolds/converge/issues/1)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
