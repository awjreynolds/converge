import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const extensionRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  files: "dist/test/**/*.test.cjs",
  extensionDevelopmentPath: extensionRoot,
  workspaceFolder: join(extensionRoot, "test-fixtures", "extension-host"),
  launchArgs: [
    "--disable-extensions",
    "--disable-gpu",
    "--skip-release-notes",
    "--skip-welcome",
  ],
  mocha: {
    timeout: 30_000,
  },
});
