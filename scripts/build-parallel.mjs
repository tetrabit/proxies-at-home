import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ["run", script], { stdio: "inherit" });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `npm run ${script} terminated by ${signal}`
            : `npm run ${script} failed with exit code ${code}`,
        ),
      );
    });
  });
}

function runScriptsInParallel(scripts) {
  return new Promise((resolve, reject) => {
    const children = [];
    let completed = 0;
    let failed = false;

    function fail(script, code, signal) {
      if (failed) {
        return;
      }

      failed = true;
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          child.kill();
        }
      }
      reject(
        new Error(
          signal
            ? `npm run ${script} terminated by ${signal}`
            : `npm run ${script} failed with exit code ${code}`,
        ),
      );
    }

    for (const script of scripts) {
      const child = spawn(npmCommand, ["run", script], { stdio: "inherit" });
      children.push(child);
      child.once("error", () => fail(script));
      child.once("exit", (code, signal) => {
        if (code !== 0) {
          fail(script, code, signal);
          return;
        }

        completed += 1;
        if (completed === scripts.length) {
          resolve();
        }
      });
    }
  });
}

await runScript("build:shared-client");
await runScriptsInParallel(["build:client", "build:server", "build:electron:ts"]);
