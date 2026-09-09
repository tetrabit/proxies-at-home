import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

let readyCallback: (() => Promise<void>) | undefined;
const updaterHandlers = new Map<string, (...args: unknown[]) => void>();
const appHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const windows: BrowserWindowMock[] = [];
const processListenerEvents = [
  "uncaughtException",
  "unhandledRejection",
] as const;
type ProcessListenerEvent = (typeof processListenerEvents)[number];
const lifecycleFixtureParent = path.resolve(process.cwd(), ".review-artifacts");
let lifecycleFixtureDirectory = "";
let processListenerBaseline = new Map<ProcessListenerEvent, Function[]>();

const appMock = {
  getPath: vi.fn((name: string) =>
    name === "userData" ? lifecycleFixtureDirectory : "/tmp"
  ),
  isPackaged: false,
  whenReady: vi.fn(() => ({
    then: vi.fn((callback: () => Promise<void>) => {
      readyCallback = callback;
      return Promise.resolve();
    }),
  })),
  on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
    appHandlers.set(event, callback);
  }),
  quit: vi.fn(),
  getVersion: vi.fn(() => "9.8.7"),
};

const ipcMainMock = {
  handle: vi.fn(
    (channel: string, callback: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, callback);
    }
  ),
};

const nativeThemeMock = { themeSource: "system" };
const dialogMock = { showErrorBox: vi.fn() };
const menuMock = {
  buildFromTemplate: vi.fn((template) => ({ template })),
  setApplicationMenu: vi.fn(),
};
const netMock = { fetch: vi.fn() };
const autoUpdaterMock = {
  logger: null as unknown,
  channel: undefined as string | undefined,
  on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
    updaterHandlers.set(event, callback);
  }),
  checkForUpdatesAndNotify: vi.fn(async () => "checked"),
  downloadUpdate: vi.fn(async () => "downloaded"),
  quitAndInstall: vi.fn(() => "installed"),
};
const microservice = {
  start: vi.fn(async () => 8181),
  stop: vi.fn(async () => undefined),
};
const createScryfallMicroservice = vi.fn(() => microservice);

class BrowserWindowMock {
  static getAllWindows = vi.fn(() => windows);

  webContents = {
    send: vi.fn(),
    openDevTools: vi.fn(),
  };

  loadURL = vi.fn();
  loadFile = vi.fn();
  on = vi.fn((event: string, callback: () => void) => {
    if (event === "closed") {
      this.close = () => {
        const index = windows.indexOf(this);
        if (index >= 0) windows.splice(index, 1);
        callback();
      };
    }
  });
  close?: () => void;

  constructor(public options: unknown) {
    windows.push(this);
  }
}

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: BrowserWindowMock,
  ipcMain: ipcMainMock,
  nativeTheme: nativeThemeMock,
  dialog: dialogMock,
  Menu: menuMock,
  net: netMock,
}));
vi.mock("electron-updater", () => ({
  default: { autoUpdater: autoUpdaterMock },
}));
vi.mock("./microservice-manager.js", () => ({
  createScryfallMicroservice,
  MicroserviceManager: class {},
}));

async function importAndRunReady(
  configure?: (mainModule: typeof import("./main.ts")) => void | Promise<void>
) {
  const mainModule = await import("./main.ts");
  await configure?.(mainModule);
  expect(readyCallback).toBeTypeOf("function");
  await readyCallback?.();
  return mainModule;
}

function response(status: number, body: unknown, statusText = "status text") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers({ "content-type": "application/json" }),
    text: vi.fn(async () =>
      typeof body === "string" ? body : JSON.stringify(body)
    ),
    json: vi.fn(async () => body),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createBeforeQuitEvent() {
  return { preventDefault: vi.fn() };
}

describe("electron main lifecycle", () => {
  beforeEach(async () => {
    await fs.promises.mkdir(lifecycleFixtureParent, { recursive: true });
    lifecycleFixtureDirectory = await fs.promises.mkdtemp(
      path.join(lifecycleFixtureParent, "electron-listener-fixture-01-")
    );
    processListenerBaseline = new Map(
      processListenerEvents.map(
        (event): [ProcessListenerEvent, Function[]] => [
          event,
          process.listeners(event),
        ]
      )
    );
    vi.clearAllMocks();
    vi.resetModules();
    readyCallback = undefined;
    updaterHandlers.clear();
    appHandlers.clear();
    ipcHandlers.clear();
    windows.length = 0;
    appMock.isPackaged = false;
    appMock.getPath.mockImplementation((name: string) =>
      name === "userData" ? lifecycleFixtureDirectory : "/tmp"
    );
    autoUpdaterMock.channel = undefined;
    microservice.start.mockResolvedValue(8181);
  });

  afterEach(() => {
    for (const event of processListenerEvents) {
      const baselineListeners = processListenerBaseline.get(event) ?? [];
      for (const listener of process.listeners(event)) {
        if (!baselineListeners.includes(listener)) {
          process.removeListener(event, listener);
        }
      }
      expect(process.listenerCount(event)).toBe(baselineListeners.length);
    }
  });

  it("boots in development, registers IPC handlers, creates the window, and forwards updater events", async () => {
    await importAndRunReady();

    expect(createScryfallMicroservice).toHaveBeenCalledOnce();
    expect(microservice.start).toHaveBeenCalledOnce();
    expect(ipcMainMock.handle.mock.calls.map(([channel]) => channel)).toEqual([
      "check-for-updates",
      "download-update",
      "install-update",
      "get-server-url",
      "get-microservice-url",
      "get-app-version",
      "get-update-channel",
      "set-update-channel",
      "get-auto-update-enabled",
      "set-auto-update-enabled",
      "mpc-preferences:load",
      "mpc-preferences:save",
      "fetch-moxfield-deck",
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].loadURL).toHaveBeenCalledWith(
      "http://localhost:5173?serverPort=3001"
    );
    expect(windows[0].webContents.openDevTools).toHaveBeenCalledOnce();
    expect(nativeThemeMock.themeSource).toBe("system");
    expect(menuMock.setApplicationMenu).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.any(Array) })
    );

    updaterHandlers.get("checking-for-update")?.();
    updaterHandlers.get("update-available")?.({ version: "1.2.3" });
    updaterHandlers.get("update-not-available")?.({ version: "1.2.2" });
    updaterHandlers.get("download-progress")?.({ percent: 42 });
    updaterHandlers.get("update-downloaded")?.({ version: "1.2.3" });
    updaterHandlers.get("error")?.(new Error("boom"));

    const helpMenu = menuMock.buildFromTemplate.mock.calls[0][0].find(
      (item: { label?: string }) => item.label === "Help"
    );
    helpMenu.submenu[0].click();
    helpMenu.submenu[2].click();

    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "checking"
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "available",
      {
        version: "1.2.3",
      }
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "not-available",
      {
        version: "1.2.2",
      }
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "downloading",
      { percent: 42 }
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "downloaded",
      {
        version: "1.2.3",
      }
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      "update-status",
      "error",
      "Error: boom"
    );
    expect(windows[0].webContents.send).toHaveBeenCalledWith("show-about");
    expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
  });

  it("implements update, preference, URL, app version, and Moxfield IPC handlers", async () => {
    await importAndRunReady();

    expect(ipcHandlers.get("check-for-updates")?.()).toBeNull();
    await expect(ipcHandlers.get("download-update")?.()).resolves.toBe(
      "downloaded"
    );
    expect(ipcHandlers.get("install-update")?.()).toBe("installed");
    expect(ipcHandlers.get("get-server-url")?.()).toBe("http://localhost:3001");
    expect(ipcHandlers.get("get-microservice-url")?.()).toBe(
      "http://localhost:8181"
    );
    expect(ipcHandlers.get("get-app-version")?.()).toBe("9.8.7");
    expect(ipcHandlers.get("get-update-channel")?.()).toBe("latest");
    expect(ipcHandlers.get("set-update-channel")?.({}, "beta")).toBe(false);
    expect(ipcHandlers.get("set-update-channel")?.({}, "stable")).toBe(true);
    expect(autoUpdaterMock.channel).toBe("stable");
    expect(ipcHandlers.get("get-auto-update-enabled")?.()).toBe(true);
    expect(ipcHandlers.get("set-auto-update-enabled")?.({}, false)).toBe(true);
    expect(ipcHandlers.get("get-auto-update-enabled")?.()).toBe(false);

    netMock.fetch.mockResolvedValueOnce(
      response(200, { name: "Deck", mainboardCount: 1, sideboardCount: 2 })
    );
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "abc")
    ).resolves.toEqual({
      name: "Deck",
      mainboardCount: 1,
      sideboardCount: 2,
    });
    expect(netMock.fetch).toHaveBeenCalledWith(
      "https://api2.moxfield.com/v2/decks/all/abc",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      })
    );

    netMock.fetch.mockResolvedValueOnce(
      response(200, { mainboardCount: 3, sideboardCount: 4 })
    );
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "fallback-name")
    ).resolves.toEqual({
      mainboardCount: 3,
      sideboardCount: 4,
    });

    netMock.fetch.mockResolvedValueOnce(response(404, "missing", "Not Found"));
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "missing")
    ).rejects.toThrow("Deck not found");
    netMock.fetch.mockResolvedValueOnce(response(403, "blocked", "Forbidden"));
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "blocked")
    ).rejects.toThrow("Access denied by Cloudflare");
    netMock.fetch.mockResolvedValueOnce(response(500, "bad", "Bad Gateway"));
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "bad")
    ).rejects.toThrow("Moxfield API error: 500 Bad Gateway");
    netMock.fetch.mockRejectedValueOnce("network down");
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "network")
    ).rejects.toBe("network down");
    const stacklessError = new Error("no stack");
    stacklessError.stack = "";
    netMock.fetch.mockRejectedValueOnce(stacklessError);
    await expect(
      ipcHandlers.get("fetch-moxfield-deck")?.({}, "stackless")
    ).rejects.toThrow("no stack");
  });

  it("uses packaged paths and honors persisted update settings", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/opt/proxxied/resources",
    });
    await fs.promises.writeFile(
      path.join(lifecycleFixtureDirectory, "electron-settings.json"),
      JSON.stringify({ updateChannel: "stable", autoUpdateEnabled: false }),
      "utf8"
    );

    await importAndRunReady();

    expect(autoUpdaterMock.channel).toBe("stable");
    expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(windows[0].loadFile).toHaveBeenCalledWith(
      expect.stringContaining("client/dist/index.html"),
      { query: { serverPort: "3001" } }
    );
    expect(windows[0].webContents.openDevTools).not.toHaveBeenCalled();
    await expect(ipcHandlers.get("check-for-updates")?.()).resolves.toBe(
      "checked"
    );
  });

  it("uses default packaged update settings, tolerates settings save errors, and starts the embedded server", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/opt/proxxied/resources",
    });
    await fs.promises.writeFile(
      path.join(lifecycleFixtureDirectory, "electron-settings.json"),
      "{bad json",
      "utf8"
    );

    await importAndRunReady((mainModule) => {
      mainModule.electronMainRuntime.importServerModule = vi.fn(
        async (modulePath: string) =>
          modulePath.endsWith("/auth/privateRouteAuth.js")
            ? {
                createSingleBearerVerifier: vi.fn(() => ({
                  verifyBearer: () => null,
                })),
              }
            : { startServer: vi.fn(async () => 4555) }
      );
    });

    expect(autoUpdaterMock.channel).toBe("latest");
    expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
    expect(ipcHandlers.get("get-server-url")?.()).toBe("http://localhost:4555");

    appMock.getPath.mockReturnValueOnce("/proc/proxxied-unwritable");
    expect(ipcHandlers.get("set-auto-update-enabled")?.({}, true)).toBe(true);
  });

  it("starts the desktop server with a launch-only loopback credential verifier", async () => {
    let configuredBearer = "";
    const createSingleBearerVerifier = vi.fn(
      (bearer: string, identity: unknown) => {
        configuredBearer = bearer;
        return {
          verifyBearer: (presentedBearer: string) =>
            presentedBearer === bearer ? identity : null,
        };
      }
    );
    const startServer = vi.fn(async (..._args: unknown[]) => 4555);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const appendSpy = vi.spyOn(fs, "appendFileSync");

    await importAndRunReady((mainModule) => {
      mainModule.electronMainRuntime.importServerModule = vi.fn(
        async (modulePath: string) =>
          modulePath.endsWith("/auth/privateRouteAuth.js")
            ? { createSingleBearerVerifier }
            : { startServer }
      );
    });

    const [token, identity] = createSingleBearerVerifier.mock.calls[0];
    const startServerOptions = startServer.mock.calls[0]?.[1] as {
      host: string;
      privateCredentialVerifier: { verifyBearer(bearer: string): unknown };
    };

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(identity).toEqual({
      ownerId: "desktop-local",
      capabilities: new Set([
        "backup:read",
        "backup:write",
        "preferences:read",
        "preferences:write",
        "calibration:read",
        "calibration:write",
        "metrics:read",
        "metrics:write",
      ]),
      transport: "desktop-loopback",
    });
    expect(startServerOptions.host).toBe("127.0.0.1");
    expect(
      startServerOptions.privateCredentialVerifier.verifyBearer(configuredBearer)
    ).toEqual(identity);
    expect(
      startServerOptions.privateCredentialVerifier.verifyBearer(
        "wrong-launch-credential"
      )
    ).toBeNull();

    const tokenWasRecorded = (calls: unknown[][]) =>
      calls.flat().some((value) =>
        typeof value === "string" && value.includes(configuredBearer)
      );
    expect(tokenWasRecorded(logSpy.mock.calls)).toBe(false);
    expect(tokenWasRecorded(errorSpy.mock.calls)).toBe(false);
    expect(tokenWasRecorded(writeSpy.mock.calls)).toBe(false);
    expect(tokenWasRecorded(appendSpy.mock.calls)).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it("uses a distinct credential on each desktop boot", async () => {
    const boot = async () => {
      let configuredBearer = "";
      const createSingleBearerVerifier = vi.fn((bearer: string) => {
        configuredBearer = bearer;
        return { verifyBearer: () => null };
      });
      const startServer = vi.fn(async () => 4555);

      vi.resetModules();
      readyCallback = undefined;
      const mainModule = await import("./main.ts");
      mainModule.electronMainRuntime.importServerModule = vi.fn(
        async (modulePath: string) =>
          modulePath.endsWith("/auth/privateRouteAuth.js")
            ? { createSingleBearerVerifier }
            : { startServer }
      );
      await readyCallback?.();
      return configuredBearer;
    };

    const firstBootCredential = await boot();
    const secondBootCredential = await boot();

    expect(firstBootCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondBootCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondBootCredential).not.toBe(firstBootCredential);
  });

  it("handles updater events before a window exists", async () => {
    await import("./main.ts");

    updaterHandlers.get("checking-for-update")?.();
    updaterHandlers.get("update-available")?.({ version: "early" });
    updaterHandlers.get("update-not-available")?.({ version: "early" });
    updaterHandlers.get("error")?.(new Error("early"));
    updaterHandlers.get("download-progress")?.({ percent: 1 });
    updaterHandlers.get("update-downloaded")?.({ version: "early" });

    expect(windows).toHaveLength(0);
  });

  it("handles non-Error microservice startup failures", async () => {
    microservice.start.mockRejectedValueOnce("microservice string failure");

    await importAndRunReady();

    expect(dialogMock.showErrorBox).toHaveBeenCalledWith(
      "Microservice Error",
      expect.stringContaining("microservice string failure")
    );
  });

  it("handles server import string failures and before-quit before startup", async () => {
    const mainModule = await import("./main.ts");
    mainModule.electronMainRuntime.importServerModule = vi.fn(async () => {
      throw "server string failure";
    });
    const beforeStartupQuit = createBeforeQuitEvent();
    await appHandlers.get("before-quit")?.(beforeStartupQuit);
    expect(beforeStartupQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledOnce());

    await readyCallback?.();

    expect(dialogMock.showErrorBox).toHaveBeenCalledWith(
      "Server Error",
      expect.stringContaining("server string failure")
    );
  });

  it("reports when an embedded server module omits startServer", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await importAndRunReady((mainModule) => {
      mainModule.electronMainRuntime.importServerModule = vi.fn(
        async (modulePath: string) =>
          modulePath.endsWith("/auth/privateRouteAuth.js")
            ? {
                createSingleBearerVerifier: vi.fn(() => ({
                  verifyBearer: () => null,
                })),
              }
            : {}
      );
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "[Electron] startServer function not found in server module"
    );
    errorSpy.mockRestore();
  });

  it("prevents repeated quit events until a deferred microservice stop settles, then permits reentry", async () => {
    const stop = createDeferred<undefined>();
    microservice.stop.mockImplementationOnce(() => stop.promise);
    await importAndRunReady();

    const initialQuit = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(initialQuit);
    expect(initialQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).toHaveBeenCalledOnce();

    const repeatedQuit = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(repeatedQuit);
    expect(repeatedQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).toHaveBeenCalledOnce();

    stop.resolve(undefined);
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledOnce());

    const reentryQuit = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(reentryQuit);
    expect(reentryQuit.preventDefault).not.toHaveBeenCalled();
    expect(microservice.stop).toHaveBeenCalledOnce();
  });

  it("routes the updater install quit through the same non-recursive gate", async () => {
    const stop = createDeferred<undefined>();
    microservice.stop.mockImplementationOnce(() => stop.promise);
    const updaterQuit = createBeforeQuitEvent();
    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      appHandlers.get("before-quit")?.(updaterQuit);
      return "installed";
    });
    await importAndRunReady();

    expect(ipcHandlers.get("install-update")?.()).toBe("installed");
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce();
    expect(updaterQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).toHaveBeenCalledOnce();

    const repeatedQuit = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(repeatedQuit);
    expect(repeatedQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).toHaveBeenCalledOnce();

    stop.resolve(undefined);
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledOnce());

    const reentryQuit = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(reentryQuit);
    expect(reentryQuit.preventDefault).not.toHaveBeenCalled();
    expect(microservice.stop).toHaveBeenCalledOnce();
  });

  it("bounds a deferred microservice stop before continuing quit", async () => {
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const stop = createDeferred<undefined>();
      microservice.stop.mockImplementationOnce(() => stop.promise);
      await importAndRunReady();

      const quitEvent = createBeforeQuitEvent();
      appHandlers.get("before-quit")?.(quitEvent);
      await vi.advanceTimersByTimeAsync(5000);

      expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
      expect(microservice.stop).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        "[Electron] Timed out stopping Scryfall microservice during quit."
      );
      expect(appMock.quit).toHaveBeenCalledOnce();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues quitting when the owned microservice stop rejects", async () => {
    microservice.stop.mockRejectedValueOnce(new Error("stop failed"));
    await importAndRunReady();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const quitEvent = createBeforeQuitEvent();
    appHandlers.get("before-quit")?.(quitEvent);
    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "[Electron] Failed to stop Scryfall microservice during quit:",
        expect.objectContaining({ message: "stop failed" })
      )
    );

    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("handles startup failures and app lifecycle events", async () => {
    microservice.start.mockRejectedValueOnce(new Error("microservice down"));

    await importAndRunReady();

    expect(dialogMock.showErrorBox).toHaveBeenCalledWith(
      "Microservice Error",
      expect.stringContaining("microservice down")
    );

    const closedWindow = windows[0];
    windows[0].close?.();
    expect(BrowserWindowMock.getAllWindows()).toEqual([]);
    const helpMenu = menuMock.buildFromTemplate.mock.calls
      .at(-1)?.[0]
      .find((item: { label?: string }) => item.label === "Help");
    helpMenu.submenu[0].click();
    expect(closedWindow.webContents.send).not.toHaveBeenCalledWith(
      "show-about"
    );
    appHandlers.get("activate")?.();
    expect(windows).toHaveLength(1);
    appHandlers.get("activate")?.();
    expect(windows).toHaveLength(1);

    appHandlers.get("window-all-closed")?.();
    expect(appMock.quit).toHaveBeenCalledOnce();
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    appHandlers.get("window-all-closed")?.();
    expect(appMock.quit).toHaveBeenCalledOnce();
    if (platformDescriptor)
      Object.defineProperty(process, "platform", platformDescriptor);
    const beforeQuit = createBeforeQuitEvent();
    await appHandlers.get("before-quit")?.(beforeQuit);
    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce();
    expect(microservice.stop).toHaveBeenCalledOnce();
  });

  it("writes crash details through global process handlers", async () => {
    const appendSpy = vi
      .spyOn(fs, "appendFileSync")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await importAndRunReady();

    process.listeners("uncaughtException").at(-1)?.(new Error("fatal"));
    const stacklessCrash = new Error("stackless fatal");
    stacklessCrash.stack = "";
    process.listeners("uncaughtException").at(-1)?.(stacklessCrash);
    process.listeners("unhandledRejection").at(-1)?.("rejected");

    expect(appendSpy).toHaveBeenCalledWith(
      expect.stringContaining("crash.log"),
      expect.stringContaining("Uncaught Exception")
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.stringContaining("crash.log"),
      expect.stringContaining("Unhandled Rejection")
    );
    expect(dialogMock.showErrorBox).toHaveBeenCalledWith(
      "Uncaught Exception",
      expect.stringContaining("fatal")
    );

    appendSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
