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

## Extension Host tests

The integration suite uses `@vscode/test-electron` directly to download the minimum supported VS Code 1.95 runtime, opens the minimal fixture
workspace, and verifies the extension's public activation and command surface:

```sh
npm run test:extension-host --workspace converge-vscode
```

The fixture configures a deliberately missing `codexPath`, so exercising **Start Pairing Session**
cannot launch a real agent. On headless Linux, run the command through `xvfb-run -a`; macOS can run
it directly. The downloaded VS Code runtime is cached under `clients/vscode/.vscode-test/` and is
ignored by Git.
