/* global process */

import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const promotionScript = fileURLToPath(new URL("./promote-preferences.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", promotionScript, ...process.argv.slice(2)],
  { stdio: "inherit" }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
