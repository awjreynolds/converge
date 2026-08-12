import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = process.env.VSCODE_TEST_CACHE_PATH ?? join(extensionRoot, ".vscode-test");
const fakePiExecutable = `#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("0.84.1");
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") {
    console.log(JSON.stringify({
      id: request.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { model: { id: "fixture-model", provider: "fixture-provider" } },
    }));
  }
  if (request.type === "get_available_models") {
    console.log(JSON.stringify({
      id: request.id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: [] },
    }));
  }
});
`;
const scenarios = [
  { name: "provider-selection", provider: "pi" },
  { name: "missing-pi", provider: "pi" },
  { name: "unsupported-pi", provider: "pi" },
  { name: "missing-pi-authentication", provider: "pi" },
  { name: "missing-authentication", provider: "claude", authentication: "missing" },
  { name: "unsupported-version", provider: "claude", authentication: "configured" },
  { name: "provider-mismatch", provider: "pi" },
  { name: "legacy-migration", provider: "codex" },
];

for (const scenario of scenarios) {
  const workspace = await mkdtemp(join(tmpdir(), `converge-${scenario.name}-`));
  try {
    const fakePiPath = join(workspace, "fake-pi.mjs");
    if (scenario.name === "missing-pi-authentication") {
      await writeFile(fakePiPath, fakePiExecutable, { encoding: "utf8", mode: 0o700 });
      await chmod(fakePiPath, 0o700);
    }
    const settingsDirectory = join(workspace, ".vscode");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(
      join(settingsDirectory, "settings.json"),
      `${JSON.stringify({
        "converge.provider": scenario.provider,
        "converge.codexPath": "__converge_test_missing_codex_executable__",
        "converge.claudePath": process.execPath,
        "converge.piPath":
          scenario.name === "missing-pi"
            ? "__converge_test_missing_pi_executable__"
            : scenario.name === "missing-pi-authentication"
              ? fakePiPath
            : process.execPath,
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
