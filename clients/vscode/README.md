# Converge for VS Code

Converge is a Reasoning Panel for following meaningful engineering decisions while an AI coding agent implements a task. It keeps each Change Unit’s intent, rationale, evidence, revisions, diff, verification, and human response together.

## Development

From the repository root:

```sh
npm run build --workspace @converge/vscode
npm run package --workspace @converge/vscode
```

Install the resulting VSIX with **Extensions: Install from VSIX…**.

The first client is a local desktop Node extension for a trusted, single-folder workspace. In Restricted Mode, existing sessions and diffs remain readable but all agent, edit, task, and terminal actions are disabled.
