import { readFile } from "node:fs/promises";

import { listFiles, PackageManager } from "@vscode/vsce";

const gatePath = "dist/pi-converge-extension.js";
const files = await listFiles({
  cwd: process.cwd(),
  packageManager: PackageManager.None,
});

if (!files.includes(gatePath)) {
  throw new Error(`VSIX file selection does not include ${gatePath}.`);
}

const [source, packaged] = await Promise.all([
  readFile("../../packages/pi/assets/converge-extension.js"),
  readFile(gatePath),
]);
if (!source.equals(packaged)) {
  throw new Error(`${gatePath} must be an untransformed copy of the reviewed Pi gate.`);
}
