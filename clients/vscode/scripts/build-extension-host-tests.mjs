import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/test/extension.test.ts"],
  external: ["vscode"],
  format: "cjs",
  minify: false,
  outfile: "dist/test/extension.test.cjs",
  platform: "node",
  sourcemap: false,
  target: "node20",
});
