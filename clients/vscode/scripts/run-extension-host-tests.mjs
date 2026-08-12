import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = process.env.VSCODE_TEST_CACHE_PATH ?? join(extensionRoot, ".vscode-test");
const scenarios = [
  { name: "provider-selection", provider: "claude" },
  { name: "missing-authentication", provider: "claude", authentication: "missing" },
  { name: "unsupported-version", provider: "claude", authentication: "configured" },
  { name: "provider-mismatch", provider: "claude" },
  { name: "legacy-migration", provider: "codex" },
];

for (const scenario of scenarios) {
  const workspace = await mkdtemp(join(tmpdir(), `converge-${scenario.name}-`));
  try {
    const settingsDirectory = join(workspace, ".vscode");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(
      join(settingsDirectory, "settings.json"),
      `${JSON.stringify({
        "converge.provider": scenario.provider,
        "converge.codexPath": "__converge_test_missing_codex_executable__",
        "converge.claudePath": process.execPath,
      }, null, 2)}\n`,
      "utf8",
    );

    const environment = {
      ...process.env,
      CONVERGE_EXTENSION_HOST_SCENARIO: scenario.name,
      ANTHROPIC_API_KEY:
        scenario.authentication === "configured"
          ? "converge-extension-host-placeholder"
          : "",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
    };
    const result = await runTests({
      cachePath,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: join(extensionRoot, "dist", "test", "extension.test.cjs"),
      extensionTestsEnv: environment,
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--disable-gpu",
        "--skip-release-notes",
        "--skip-welcome",
      ],
      version: process.env.VSCODE_TEST_VERSION ?? "1.95.0",
    });
    if (result !== 0) process.exitCode = result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
