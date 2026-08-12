# Converge for VS Code

Converge is a Reasoning Panel for following meaningful engineering decisions while an AI coding agent implements a task. It keeps each Change Unit’s intent, rationale, evidence, revisions, diff, verification, and human response together.

## Development

From the repository root:

```sh
npm run build --workspace converge-vscode
npm run package --workspace converge-vscode
```

Install the resulting VSIX with **Extensions: Install from VSIX…**.

The first client is a local desktop Node extension for a trusted, single-folder workspace. In Restricted Mode, existing sessions and diffs remain readable but all agent, edit, task, and terminal actions are disabled.

Choose `codex` (the default), `claude`, or `pi` with `converge.provider`. Existing Pairing Sessions
must be resumed with the provider that created them. The corresponding `converge.codexPath`,
`converge.claudePath`, and `converge.piPath` settings select local provider executables.
Authentication stays entirely provider-owned; Converge has no API-key or credential setting. The
Reasoning Panel identifies the selected provider, shows capability limits, and offers **Stop agent**
while a turn is active.

The packaged extension uses a local Claude Code installation instead of embedding Anthropic's large
platform binary. Set `converge.claudePath` when `claude` is not on VS Code's process path. Converge
checks Claude Code `2.1.228` and provider-owned API/cloud authentication before it persists a new
Pairing Session. Direct Claude use requires `ANTHROPIC_API_KEY`; Bedrock requires
`AWS_BEARER_TOKEN_BEDROCK` or an explicit access/secret key pair; Vertex requires
`GOOGLE_APPLICATION_CREDENTIALS`; and Foundry requires `ANTHROPIC_FOUNDRY_API_KEY` or
`ANTHROPIC_FOUNDRY_AUTH_TOKEN`. Codex uses the account configured by `codex login`.

Pi retains ownership of model selection, provider login, and credential storage. Converge launches
the configured local Pi CLI with only its packaged approval-gate extension, so project extensions
cannot bypass the Converge execution-approval boundary. The gate denies unknown tools and separates
command or workspace-mutation approval from Change Unit approval. Shell-created network activity is
not isolated unless the workspace has an external sandbox or egress boundary.

## Extension Host tests

The integration suite uses `@vscode/test-electron` directly to download the minimum supported VS Code 1.95 runtime, opens the minimal fixture
workspace, and verifies the extension's public activation and command surface:

```sh
npm run test:extension-host --workspace converge-vscode
```

The tests launch isolated fixture workspaces and inspect the activated production extension for
provider selection, missing installations or authentication, unsupported versions, provider
mismatch, and legacy migration. They never run a provider turn, contact an external service, or send
repository content.
Workspace trust itself cannot be toggled by this harness, so that boundary remains covered through
the injected host-capability test. On headless Linux, run the command through `xvfb-run -a`; macOS
can run it directly. The downloaded VS Code runtime is cached under
`clients/vscode/.vscode-test/` and is ignored by Git.
