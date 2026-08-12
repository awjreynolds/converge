import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await Promise.all([
  build({
    bundle: true,
    entryPoints: ["src/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    minify: true,
    outfile: "dist/extension.cjs",
    platform: "node",
    sourcemap: false,
    target: "node20",
  }),
  build({
    bundle: true,
    entryPoints: ["src/webview/index.ts"],
    format: "iife",
    minify: true,
    outfile: "dist/webview.js",
    platform: "browser",
    sourcemap: false,
    target: "es2022",
  }),
  mkdir("dist", { recursive: true }).then(() =>
    copyFile(
      "../../packages/pi/assets/converge-extension.js",
      "dist/pi-converge-extension.js",
    ),
  ),
]);
