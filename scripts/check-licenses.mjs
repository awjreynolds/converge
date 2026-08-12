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
  "SEE LICENSE IN LICENSE.txt",
  "Unlicense",
  "WTFPL",
]);

// khroma@2.1.0 omits the package.json field, but ships an MIT `license` file.
const reviewedMissingMetadata = new Map([["khroma@2.1.0", "MIT"]]);

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
