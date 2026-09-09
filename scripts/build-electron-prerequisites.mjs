import { spawn } from "node:child_process";

const MAX_CONCURRENT_PREREQUISITES = 2;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function commandFailure(label, code, signal, cause) {
  if (cause) {
    return new Error(`${label} could not start: ${cause.message}`);
  }
  return new Error(
    signal
      ? `${label} terminated by ${signal}`
      : `${label} failed with exit code ${code}`,
  );
}

function startCommand({ command, args, label }) {
  let child;
  let hasSettled = false;
  const completed = new Promise((resolve, reject) => {
    child = spawn(command, args, {
      stdio: "inherit",
      // On POSIX, isolate each command so failure cleanup also reaches npm's build child.
      detached: process.platform !== "win32",
    });
    child.once("error", (error) => {
      hasSettled = true;
      reject(commandFailure(label, undefined, undefined, error));
    });
    child.once("exit", (code, signal) => {
      hasSettled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(commandFailure(label, code, signal));
    });
  });

  return {
    completed,
    get child() {
      return child;
    },
    get hasSettled() {
      return hasSettled;
    },
  };
}

function terminateUnsettled(commands) {
  for (const command of commands) {
    if (command.hasSettled || !command.child) {
      continue;
    }

    if (process.platform !== "win32" && command.child.pid) {
      try {
        process.kill(-command.child.pid, "SIGTERM");
        continue;
      } catch {
        // Fall through to the direct child signal if process-group delivery races its exit.
      }
    }
    command.child.kill("SIGTERM");
  }
}

/**
 * Build the Rust artifact and the aggregate JavaScript artifacts concurrently.
 * The two branches are the complete, deliberate concurrency budget for packaging.
 */
export async function buildElectronPrerequisites() {
  const commands = [
    { command: "bash", args: ["scripts/build-microservice.sh"], label: "Rust microservice build" },
    { command: npmCommand, args: ["run", "build:parallel"], label: "JavaScript aggregate build" },
  ];
  if (commands.length !== MAX_CONCURRENT_PREREQUISITES) {
    throw new Error(`Expected exactly ${MAX_CONCURRENT_PREREQUISITES} Electron prerequisite branches`);
  }

  const started = commands.map(startCommand);
  let failure;
  const settled = started.map((command) => command.completed.catch((error) => {
    if (!failure) {
      failure = error;
      terminateUnsettled(started);
    }
    throw error;
  }));

  await Promise.allSettled(settled);
  if (failure) {
    throw failure;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  buildElectronPrerequisites().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
