import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_SANDBOX_SWITCHES = ['--no-sandbox', '--disable-setuid-sandbox'];
const XVFB_ARGS = ['-displayfd', '3', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-noreset'];

function forbiddenSwitch(args) {
  return args.find(arg => FORBIDDEN_SANDBOX_SWITCHES.some(switchName => arg === switchName || arg.startsWith(`${switchName}=`)));
}

function ozoneSwitch(args) {
  return args.find(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='));
}

function onceExit(child) {
  return once(child, 'exit').then(([code, signal]) => ({ code, signal }));
}

export function isolatedElectronLaunchConfig({ display, parentEnv = process.env, args = [] }) {
  if (!/^:\d+$/.test(display)) throw new Error(`Invalid owned Xvfb DISPLAY: ${display}`);
  if (parentEnv.DISPLAY === display) throw new Error(`Refusing inherited DISPLAY ${display}`);
  const forbidden = forbiddenSwitch(args);
  if (forbidden) throw new Error(`Refusing forbidden sandbox-disabling switch: ${forbidden}`);
  const ozone = ozoneSwitch(args);
  if (ozone && ozone !== '--ozone-platform=x11') throw new Error('Probe arguments must not override --ozone-platform=x11');
  const chromiumArgs = ozone ? [...args] : [...args, '--ozone-platform=x11'];
  const env = { ...parentEnv, DISPLAY: display, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  delete env.WAYLAND_DISPLAY;
  delete env.XAUTHORITY;
  return { env, chromiumArgs };
}

export async function startOwnedXvfb({ evidence, parentEnv = process.env, args = [], xvfbExecutable = 'Xvfb' } = {}) {
  if (!evidence) throw new Error('Owned Xvfb requires an evidence directory');
  const command = [xvfbExecutable, ...XVFB_ARGS];
  let stderr = '';
  let displayText = '';
  let exit;
  const child = spawn(xvfbExecutable, XVFB_ARGS, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const exitPromise = onceExit(child).then(value => { exit = value; return value; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdio[3].on('data', chunk => { displayText += chunk; });

  const writeReport = async (lifecycle, extra = {}) => {
    await Promise.all([
      writeFile(path.join(evidence, 'xvfb.stderr.log'), stderr),
      writeFile(path.join(evidence, 'xvfb.json'), JSON.stringify({
        command,
        pid: child.pid,
        parentDisplay: parentEnv.DISPLAY ?? null,
        display: displayText.trim() ? `:${displayText.trim()}` : null,
        lifecycle,
        ...extra,
      }, null, 2)),
    ]);
  };

  try {
    const number = await Promise.race([
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Xvfb -displayfd')), 10_000);
        const finish = () => {
          const match = displayText.match(/^\s*(\d+)\s*$/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        };
        child.stdio[3].on('data', finish);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Xvfb exited before assigning a display (code ${code}, signal ${signal})`)); });
        finish();
      }),
      exitPromise.then(({ code, signal }) => Promise.reject(new Error(`Xvfb exited before assigning a display (code ${code}, signal ${signal})`))),
    ]);
    const display = `:${number}`;
    const config = isolatedElectronLaunchConfig({ display, parentEnv, args });
    await writeReport('running');
    let closed = false;
    return {
      ...config,
      display,
      pid: child.pid,
      async close() {
        if (closed) return;
        closed = true;
        if (!exit) {
          child.kill('SIGTERM');
          await Promise.race([
            exitPromise,
            new Promise(resolve => setTimeout(resolve, 5_000)),
          ]);
        }
        if (!exit) {
          child.kill('SIGKILL');
          await exitPromise;
        }
        await writeReport('reaped', { exit });
      },
    };
  } catch (error) {
    if (!exit) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (!exit) {
      child.kill('SIGKILL');
      await exitPromise;
    }
    await writeReport('failed', { exit, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function assertFrontendReady({ evidence, url = 'http://localhost:5173/' } = {}) {
  if (!evidence) throw new Error('Frontend preflight requires an evidence directory');
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    const report = { url, startedAt, status: response.status, ok: response.ok };
    await writeFile(path.join(evidence, 'frontend-preflight.json'), JSON.stringify(report, null, 2));
    if (!response.ok) throw new Error(`Frontend health preflight failed: ${url} returned ${response.status}`);
    return report;
  } catch (error) {
    await writeFile(path.join(evidence, 'frontend-preflight.json'), JSON.stringify({
      url,
      startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    throw error;
  }
}

export async function launchElectronOnOwnedXvfb({ evidence, parentEnv = process.env, args, launch, launchOptions = {} }) {
  if (typeof launch !== 'function') throw new Error('launchElectronOnOwnedXvfb requires a launch function');
  // Preserve the caller's isolated profile/data/native-addon environment before
  // replacing only the display fields. Dropping it would reuse the user profile.
  const owned = await startOwnedXvfb({ evidence, parentEnv: launchOptions.env ?? parentEnv, args });
  let app;
  try {
    app = await launch({ ...launchOptions, args: [...args, ...owned.chromiumArgs.filter(arg => !args.includes(arg))], env: owned.env });
    const runtime = await app.evaluate(() => ({
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      ozonePlatform: process.argv.find(arg => arg.startsWith('--ozone-platform=')) ?? null,
    }));
    if (runtime.display !== owned.display || runtime.waylandDisplay !== null || runtime.ozonePlatform !== '--ozone-platform=x11') {
      throw new Error(`Electron isolation verification failed: ${JSON.stringify(runtime)}`);
    }
    return {
      app,
      display: owned.display,
      pid: owned.pid,
      runtime,
      async close() {
        try {
          await app.close();
        } finally {
          await owned.close();
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await owned.close();
    }
    throw error;
  }
}
