import { readFile } from "node:fs/promises";

const approvedLicenses = new Set([
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "(MIT OR GPL-3.0-or-later)",
  "(MIT OR WTFPL)",
  "(MPL-2.0 OR Apache-2.0)",
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
]);

// khroma@2.1.0 omits the package.json field, but ships an MIT `license` file.
const reviewedMissingMetadata = new Map([["khroma@2.1.0", "MIT"]]);

// These optional, platform-specific binaries are internal tooling dependencies of
// the official VSIX packager. Their Microsoft license is not open source, so they
// are intentionally permitted only as pinned development tools and never as
// runtime/shipped dependencies.
const reviewedRestrictedBuildTools = new Set([
  "@vscode/vsce-sign@2.0.9",
  "@vscode/vsce-sign-alpine-arm64@2.0.6",
  "@vscode/vsce-sign-alpine-x64@2.0.6",
  "@vscode/vsce-sign-darwin-arm64@2.0.6",
  "@vscode/vsce-sign-darwin-x64@2.0.6",
  "@vscode/vsce-sign-linux-arm@2.0.6",
  "@vscode/vsce-sign-linux-arm64@2.0.6",
  "@vscode/vsce-sign-linux-x64@2.0.6",
  "@vscode/vsce-sign-win32-arm64@2.0.6",
  "@vscode/vsce-sign-win32-x64@2.0.6",
]);

// This optional runtime integration is selected explicitly by the user and is
// governed by Anthropic's Commercial Terms rather than Converge's MIT license.
// Keep the exception exact so a version or metadata change requires a new review.
const reviewedRestrictedProviderRuntimes = new Map([
  ["@anthropic-ai/claude-agent-sdk@0.3.228", { license: "SEE LICENSE IN README.md", optional: false }],
  ["@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-linux-x64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
  ["@anthropic-ai/claude-agent-sdk-win32-x64@0.3.228", { license: "SEE LICENSE IN LICENSE.md", optional: true }],
]);

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const rejected = [];
let checked = 0;

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || entry.link) {
    continue;
  }

  checked += 1;
  const name = path.slice("node_modules/".length);
  const key = `${name}@${entry.version ?? "unknown"}`;
  const license = entry.license ?? reviewedMissingMetadata.get(key);

  if (reviewedRestrictedBuildTools.has(key)) {
    if (!entry.dev || entry.license !== "SEE LICENSE IN LICENSE.txt") {
      rejected.push(`${key}: restricted build-tool classification changed`);
    }
    continue;
  }

  const reviewedProviderRuntime = reviewedRestrictedProviderRuntimes.get(key);
  if (reviewedProviderRuntime !== undefined) {
    if (
      entry.dev ||
      entry.license !== reviewedProviderRuntime.license ||
      Boolean(entry.optional) !== reviewedProviderRuntime.optional
    ) {
      rejected.push(`${key}: restricted provider-runtime classification changed`);
    }
    continue;
  }

  if (!license || !approvedLicenses.has(license)) {
    rejected.push(`${key}: ${license ?? "missing license metadata"}`);
  }
}

if (rejected.length > 0) {
  console.error("Dependency licenses require review:\n" + rejected.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} dependency licenses against the approved policy.`);
}
