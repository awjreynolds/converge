import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = process.env.VSCODE_TEST_CACHE_PATH ?? join(extensionRoot, ".vscode-test");

process.exitCode = await runTests({
  cachePath,
  extensionDevelopmentPath: extensionRoot,
  extensionTestsPath: join(extensionRoot, "dist", "test", "extension.test.cjs"),
  extensionTestsEnv: {
    ...process.env,
    ANTHROPIC_API_KEY: "converge-extension-host-placeholder",
  },
  launchArgs: [
    join(extensionRoot, "test-fixtures", "extension-host"),
    "--disable-extensions",
    "--disable-gpu",
    "--skip-release-notes",
    "--skip-welcome",
  ],
  version: process.env.VSCODE_TEST_VERSION ?? "1.95.0",
});
