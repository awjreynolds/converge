import { build } from "esbuild";

await Promise.all([
  build({
    bundle: true,
    entryPoints: ["src/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    outfile: "dist/extension.cjs",
    platform: "node",
    sourcemap: true,
    target: "node20",
  }),
  build({
    bundle: true,
    entryPoints: ["src/webview/index.ts"],
    format: "iife",
    outfile: "dist/webview.js",
    platform: "browser",
    sourcemap: true,
    target: "es2022",
  }),
]);
