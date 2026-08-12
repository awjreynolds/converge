import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["packages/**/src/**/*.ts", "clients/**/src/**/*.ts"],
    },
    include: [
      "packages/**/*.test.ts",
      "clients/**/*.test.ts",
    ],
  },
});
