import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tetrabit/scryfall-cache-client": fileURLToPath(new URL("../shared/scryfall-client/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/utils/scryfallContract.optin.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
  },
});