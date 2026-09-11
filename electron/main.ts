import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  dialog,
  Menu,
  MenuItemConstructorOptions,
  net,
} from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { randomBytes } from "node:crypto";
import fs from "fs";
import pkg from "electron-updater";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { MpcPreferenceFixture } from "./mpc-preferences.js";
const { autoUpdater } = pkg;
import {
  createScryfallMicroservice,
  MicroserviceManager,
} from "./microservice-manager.js";
import { registerMicroserviceQuitGate } from "./quit-gate.js";
import { registerCalibrationHarnessIpcHandlers } from "./calibration-harness-ipc.js";

export const electronMainRuntime = {
  importServerModule(serverScript: string): Promise<Record<string, unknown>> {
    return import(pathToFileURL(serverScript).href);
  },
};

const desktopPrivateCapabilities = [
  "backup:read",
  "backup:write",
  "preferences:read",
  "preferences:write",
  "calibration:read",
  "calibration:write",
  "metrics:read",
  "metrics:write",
] as const;

type DesktopPrivateIdentity = {
  ownerId: "desktop-local";
  capabilities: ReadonlySet<(typeof desktopPrivateCapabilities)[number]>;
  transport: "desktop-loopback";
};

type PrivateCredentialVerifier = {
  verifyBearer(bearer: string): unknown;
};

type DesktopCredentialSession = {
  bearer: string;
  verifier: PrivateCredentialVerifier;
};

type CreateSingleBearerVerifier = (
  bearer: string,
  identity: DesktopPrivateIdentity
) => PrivateCredentialVerifier;

type StartServer = (
  port: number,
  options: {
    host: string;
    privateCredentialVerifier: PrivateCredentialVerifier;
  }
) => Promise<number>;

function createDesktopCredentialVerifier(
  createSingleBearerVerifier: CreateSingleBearerVerifier
): DesktopCredentialSession {
  const bearer = randomBytes(32).toString("base64url");
  return {
    bearer,
    verifier: createSingleBearerVerifier(bearer, {
      ownerId: "desktop-local",
      capabilities: new Set(desktopPrivateCapabilities),
      transport: "desktop-loopback",
    }),
  };
}

type ElectronSettings = {
  autoUpdateEnabled?: boolean;
  updateChannel?: string;
};

let electronSettings: ElectronSettings = {};
let pendingElectronSettingsWrite: Promise<void> = Promise.resolve();

// Settings file for persistent electron-specific settings
function getSettingsPath() {
  return path.join(app.getPath("userData"), "electron-settings.json");
}

async function loadElectronSettingsFromDisk(
  settingsPath: string = getSettingsPath()
): Promise<ElectronSettings> {
  try {
    const payload = await fs.promises.readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Settings file must contain a JSON object");
    }
    return parsed as ElectronSettings;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return {};
    }
    throw e;
  }
}

async function initializeElectronSettings(): Promise<void> {
  electronSettings = await loadElectronSettingsFromDisk();
}

async function writeElectronSettingsAtomically(
  settingsPath: string,
  settings: ElectronSettings
): Promise<void> {
  const tempPath = path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const payload = `${JSON.stringify(settings, null, 2)}\n`;

  await fs.promises.writeFile(tempPath, payload, "utf8");
  await fs.promises.rename(tempPath, settingsPath);
}

function saveElectronSettings(settings: ElectronSettings): Promise<void> {
  const writeOperation = pendingElectronSettingsWrite.then(async () => {
    const nextSettings = { ...electronSettings, ...settings };
    await writeElectronSettingsAtomically(getSettingsPath(), nextSettings);
    electronSettings = nextSettings;
  });

  pendingElectronSettingsWrite = writeOperation.catch(() => undefined);
  return writeOperation;
}

const MPC_PREFERENCES_FILENAME = "mpc-preferences.user.json";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNumberOrNullRecord(
  value: unknown
): value is Record<string, number | null> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) => typeof item === "number" || item === null
    )
  );
}

function validateMpcPreferenceFixture(data: unknown): MpcPreferenceFixture {
  if (!isRecord(data)) {
    throw new Error("Invalid preference fixture: not a JSON object");
  }

  if (typeof data.version !== "number") {
    throw new Error("Invalid preference fixture: missing version");
  }

  if (typeof data.exportedAt !== "string") {
    throw new Error("Invalid preference fixture: missing exportedAt");
  }

  if (!Array.isArray(data.cases)) {
    throw new Error("Invalid preference fixture: missing cases array");
  }

  for (const testCase of data.cases) {
    if (!isRecord(testCase) || !isRecord(testCase.source)) {
      throw new Error("Invalid preference fixture: malformed case");
    }

    if (
      typeof testCase.source.name !== "string" ||
      !isOptionalString(testCase.source.set) ||
      !isOptionalString(testCase.source.collectorNumber) ||
      !isOptionalString(testCase.source.sourceImageUrl) ||
      !isOptionalString(testCase.source.sourceArtImageUrl)
    ) {
      throw new Error("Invalid preference fixture: malformed source card");
    }

    if (!Array.isArray(testCase.candidates)) {
      throw new Error(
        "Invalid preference fixture: candidates must be an array"
      );
    }

    for (const candidate of testCase.candidates) {
      if (!isRecord(candidate)) {
        throw new Error(
          "Invalid preference fixture: candidate must be an object"
        );
      }

      if (
        typeof candidate.identifier !== "string" ||
        typeof candidate.name !== "string" ||
        typeof candidate.rawName !== "string" ||
        typeof candidate.smallThumbnailUrl !== "string" ||
        typeof candidate.mediumThumbnailUrl !== "string" ||
        !isOptionalString(candidate.imageUrl) ||
        typeof candidate.dpi !== "number" ||
        !Array.isArray(candidate.tags) ||
        !candidate.tags.every((tag) => typeof tag === "string") ||
        typeof candidate.sourceName !== "string" ||
        typeof candidate.source !== "string" ||
        typeof candidate.extension !== "string" ||
        typeof candidate.size !== "number"
      ) {
        throw new Error("Invalid preference fixture: malformed candidate");
      }
    }

    if (
      !isOptionalString(testCase.expectedIdentifier) ||
      !isOptionalString(testCase.notes)
    ) {
      throw new Error("Invalid preference fixture: malformed case metadata");
    }

    if (testCase.comparisonHints !== undefined) {
      if (!isRecord(testCase.comparisonHints)) {
        throw new Error(
          "Invalid preference fixture: malformed comparison hints"
        );
      }

      if (
        (testCase.comparisonHints.fullCard !== undefined &&
          !isNumberOrNullRecord(testCase.comparisonHints.fullCard)) ||
        (testCase.comparisonHints.artMatch !== undefined &&
          !isNumberOrNullRecord(testCase.comparisonHints.artMatch))
      ) {
        throw new Error(
          "Invalid preference fixture: malformed comparison hints"
        );
      }
    }
  }

  return {
    version: data.version,
    exportedAt: data.exportedAt,
    cases: data.cases,
  };
}

export function getMpcPreferencesPath(
  appLike: Pick<typeof app, "getPath"> = app
): string {
  return path.join(appLike.getPath("userData"), MPC_PREFERENCES_FILENAME);
}

export async function loadMpcPreferencesFromDisk(
  filePath: string = getMpcPreferencesPath()
): Promise<MpcPreferenceFixture | null> {
  try {
    const payload = await fs.promises.readFile(filePath, "utf8");
    return validateMpcPreferenceFixture(JSON.parse(payload));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[Electron] Failed to load MPC preferences: ${reason}`);
  }
}

let pendingMpcPreferenceWrite = Promise.resolve();

async function writeMpcPreferencesAtomically(
  filePath: string,
  fixture: MpcPreferenceFixture
): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const payload = `${JSON.stringify(fixture, null, 2)}\n`;

  await fs.promises.mkdir(directory, { recursive: true });

  try {
    await fs.promises.writeFile(tempPath, payload, "utf8");
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function saveMpcPreferencesToDisk(
  fixture: MpcPreferenceFixture,
  filePath: string = getMpcPreferencesPath()
): Promise<void> {
  const validatedFixture = validateMpcPreferenceFixture(fixture);
  const writeOperation = pendingMpcPreferenceWrite.then(() =>
    writeMpcPreferencesAtomically(filePath, validatedFixture)
  );

  pendingMpcPreferenceWrite = writeOperation.catch(() => undefined);
  await writeOperation;
}

export function registerMpcPreferenceIpcHandlers(
  ipcMainLike: Pick<IpcMain, "handle">,
  appLike: Pick<typeof app, "getPath"> = app
): void {
  ipcMainLike.handle("mpc-preferences:load", async () => {
    return loadMpcPreferencesFromDisk(getMpcPreferencesPath(appLike));
  });

  ipcMainLike.handle(
    "mpc-preferences:save",
    async (_event, fixture: MpcPreferenceFixture) => {
      await saveMpcPreferencesToDisk(fixture, getMpcPreferencesPath(appLike));
    }
  );
}

// Handle ESM imports for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global error handlers to catch silent crashes
process.on("uncaughtException", (error) => {
  const logPath = path.join(app.getPath("userData"), "crash.log");
  fs.appendFileSync(
    logPath,
    `[${new Date().toISOString()}] Uncaught Exception: ${error.stack || error}\n`
  );
  console.error("Uncaught Exception:", error);
  dialog.showErrorBox("Uncaught Exception", error.stack || error.toString());
});

process.on("unhandledRejection", (reason) => {
  const logPath = path.join(app.getPath("userData"), "crash.log");
  fs.appendFileSync(
    logPath,
    `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`
  );
  console.error("Unhandled Rejection:", reason);
});

let mainWindow: BrowserWindow | null = null;
let serverPort = 3001; // Default port, will be updated if server starts successfully
let microserviceManager: MicroserviceManager | null = null;
let microservicePort = 8080;
let desktopPrivateBootstrap: { baseUrl: string; bearer: string } | null = null;
let disposeCalibrationHarnessIpc: (() => Promise<void>) | null = null;
type DesktopServiceReadiness = "starting" | "ready" | "failed";
let desktopServiceReadiness: DesktopServiceReadiness = "starting";

function assertDesktopServicesReady(): void {
  if (desktopServiceReadiness !== "ready") {
    throw new Error("Desktop services are not ready");
  }
}

function getStartupShellUrl(state: "loading" | "failed"): string {
  const title =
    state === "loading" ? "Starting Proxxied" : "Proxxied could not start";
  const message =
    state === "loading"
      ? "Preparing required local services…"
      : "A required local service could not be started. Close Proxxied and try again.";
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f9fafb;font-family:system-ui,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}h1{margin:0 0 .75rem;font-size:1.5rem}p{margin:0;color:#d1d5db;line-height:1.5}</style></head><body><main role="status"><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function showStartupShell(state: "loading" | "failed"): void {
  void mainWindow?.loadURL(getStartupShellUrl(state));
}

function getPackagedIndexPath(): string {
  return path.join(__dirname, "../../client/dist/index.html");
}

function getExpectedRendererUrl(): string {
  const rendererUrl = app.isPackaged
    ? pathToFileURL(getPackagedIndexPath()).href
    : "http://localhost:5173";
  const expectedUrl = new URL(rendererUrl);
  expectedUrl.searchParams.set("serverPort", serverPort.toString());
  return expectedUrl.href;
}

function getTrustedPrivateApiBootstrap(
  event: IpcMainInvokeEvent
): { baseUrl: string; bearer: string } {
  if (
    desktopPrivateBootstrap === null ||
    mainWindow === null ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    event.senderFrame.url !== getExpectedRendererUrl()
  ) {
    throw new Error("Private API bootstrap unavailable");
  }

  return desktopPrivateBootstrap;
}

// Auto-updater logging
autoUpdater.logger = console;

// Configure update channel based on user preference or version
// Users can choose: 'latest' (all updates) or 'stable' (major versions only)
function configureUpdateChannel() {
  // Check if user has set a specific channel
  if (
    electronSettings.updateChannel === "stable" ||
    electronSettings.updateChannel === "latest"
  ) {
    autoUpdater.channel = electronSettings.updateChannel;
    console.log(
      `[Electron] Update channel: ${electronSettings.updateChannel} (user preference)`
    );
    return;
  }

  // Default to 'latest' channel for all users
  autoUpdater.channel = "latest";
  console.log("[Electron] Update channel: latest (default)");
}

function createWindow() {
  const isDev = !app.isPackaged;

  // In production, most files are inside app.asar
  // Use path.join(__dirname, ...) for asar-packed files
  // Use process.resourcesPath for extraResources (unpacked files)
  const iconPath = isDev
    ? path.join(__dirname, "../../client/public/pwa-512x512.png")
    : path.join(
        process.resourcesPath,
        "app.asar",
        "client",
        "dist",
        "pwa-512x512.png"
      );

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Force system theme
  nativeTheme.themeSource = "system";

  if (desktopServiceReadiness === "ready") {
    loadTrustedRenderer();
  } else {
    showStartupShell(
      desktopServiceReadiness === "failed" ? "failed" : "loading"
    );
  }

  // Create Menu
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [{ role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Proxxied",
          click: () => {
            mainWindow?.webContents.send("show-about");
          },
        },
        { type: "separator" },
        {
          label: "Check for Updates",
          click: () => {
            autoUpdater.checkForUpdatesAndNotify();
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function checkForStartupUpdates(): void {
  if (!app.isPackaged) {
    return;
  }

  configureUpdateChannel();
  if (electronSettings.autoUpdateEnabled !== false) {
    // Default to enabled
    void autoUpdater.checkForUpdatesAndNotify();
  } else {
    console.log("[Electron] Auto-update check disabled by user");
  }
}

function stopMicroserviceAfterServerStartupFailure(): Promise<void> {
  const manager = microserviceManager;
  if (manager === null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error("[Electron] Timed out stopping Scryfall microservice after server startup failure.");
      resolve();
    }, 5000);

    manager.stop().then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        console.error("[Electron] Failed to stop Scryfall microservice after server startup failure:", error);
        resolve();
      }
    );
  });
}

function loadTrustedRenderer(): void {
  if (mainWindow === null || desktopServiceReadiness !== "ready") {
    return;
  }

  if (!app.isPackaged) {
    const url = `http://localhost:5173?serverPort=${serverPort}`;
    void mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools();
    return;
  }

  // In prod with asar, __dirname is electron/dist/, need ../../ to reach root
  const indexPath = getPackagedIndexPath();
  console.log("[Electron] Loading index from:", indexPath);
  void mainWindow.loadFile(indexPath, {
    query: { serverPort: serverPort.toString() },
  });
}

// IPC Handlers for Auto-Updater
ipcMain.handle("check-for-updates", () => {
  if (app.isPackaged) {
    return autoUpdater.checkForUpdatesAndNotify();
  }
  return null;
});

ipcMain.handle("download-update", () => {
  return autoUpdater.downloadUpdate();
});

ipcMain.handle("install-update", () => {
  return autoUpdater.quitAndInstall();
});

// Forward auto-updater events to renderer
autoUpdater.on("checking-for-update", () => {
  mainWindow?.webContents.send("update-status", "checking");
});

autoUpdater.on("update-available", (info: unknown) => {
  mainWindow?.webContents.send("update-status", "available", info);
});

autoUpdater.on("update-not-available", (info: unknown) => {
  mainWindow?.webContents.send("update-status", "not-available", info);
});

autoUpdater.on("error", (err: Error) => {
  mainWindow?.webContents.send("update-status", "error", err.toString());
});

autoUpdater.on("download-progress", (progressObj: unknown) => {
  mainWindow?.webContents.send("update-status", "downloading", progressObj);
});

autoUpdater.on("update-downloaded", (info: unknown) => {
  mainWindow?.webContents.send("update-status", "downloaded", info);
});

app.whenReady().then(async () => {
  const isDev = !app.isPackaged;
  createWindow();

  ipcMain.handle("get-server-url", () => {
    assertDesktopServicesReady();
    return `http://localhost:${serverPort}`;
  });
  ipcMain.handle("get-private-api-bootstrap", async (event) =>
    getTrustedPrivateApiBootstrap(event)
  );
  ipcMain.handle("get-microservice-url", () => {
    assertDesktopServicesReady();
    return `http://localhost:${microservicePort}`;
  });
  if (disposeCalibrationHarnessIpc !== null) {
    await disposeCalibrationHarnessIpc();
  }
  disposeCalibrationHarnessIpc = registerCalibrationHarnessIpcHandlers({
    ipcMain,
    getMainWebContents: () => mainWindow?.webContents ?? null,
    expectedRendererUrl: getExpectedRendererUrl,
    configPath: () => path.join(app.getPath("userData"), "calibration-harness.connection.json"),
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  try {
    await initializeElectronSettings();
  } catch (error) {
    electronSettings = {};
    console.error("[Electron] Failed to load settings:", error);
  }
  checkForStartupUpdates();

  // Start Scryfall microservice first
  try {
    microserviceManager = createScryfallMicroservice();
    microservicePort = await microserviceManager.start();
    console.log(
      "[Electron] Scryfall microservice started on port:",
      microservicePort
    );
  } catch (err: unknown) {
    console.error("[Electron] Failed to start microservice:", err);
    const errorMessage =
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    dialog.showErrorBox(
      "Microservice Error",
      `Failed to start Scryfall microservice:\n${errorMessage}`
    );
    desktopServiceReadiness = "failed";
    showStartupShell("failed");
    return;
  }

  // Start the Express server inside Electron's process
  // This makes the app standalone (no Node.js required on user machine)

  // In dev, use relative path from electron/dist/
  // In production, server is in extraResources (resources/server/)
  let serverDir: string;
  let serverScript: string;
  if (isDev) {
    serverDir = path.join(__dirname, "../../server");
    serverScript = path.join(serverDir, "dist/server/src/index.js");
  } else {
    // extraResources are copied to the resources folder
    serverDir = path.join(process.resourcesPath, "server");
    serverScript = path.join(serverDir, "dist/server/src/index.js");
  }

  // Log paths for debugging
  console.log("[Electron] Server dir:", serverDir);
  console.log("[Electron] Server script:", serverScript);
  console.log("[Electron] Script exists:", fs.existsSync(serverScript));

  try {
    // Dynamic import to run server in Electron's process
    const serverModule =
      await electronMainRuntime.importServerModule(serverScript);
    console.log("[Electron] Server Module Keys:", Object.keys(serverModule));
    const startServer = serverModule.startServer;

    if (typeof startServer === "function") {
      const authProviderScript = path.join(
        path.dirname(serverScript),
        "auth",
        "privateRouteAuth.js"
      );
      const authProviderModule =
        await electronMainRuntime.importServerModule(authProviderScript);
      const createSingleBearerVerifier =
        authProviderModule.createSingleBearerVerifier;

      if (typeof createSingleBearerVerifier !== "function") {
        throw new Error(
          "[Electron] createSingleBearerVerifier function not found in server auth provider"
        );
      }

      const desktopCredentialSession = createDesktopCredentialVerifier(
        createSingleBearerVerifier as CreateSingleBearerVerifier
      );
      const privateCredentialVerifier = desktopCredentialSession.verifier;
      serverPort = await (startServer as StartServer)(0, {
        host: "127.0.0.1",
        privateCredentialVerifier,
      }); // 0 = random available port
      desktopPrivateBootstrap = {
        baseUrl: `http://127.0.0.1:${serverPort}`,
        bearer: desktopCredentialSession.bearer,
      };
      console.log("[Electron] Server started on port:", serverPort);
    } else {
      const message = "[Electron] startServer function not found in server module";
      console.error(message);
      throw new Error(message);
    }
  } catch (err: unknown) {
    console.error("[Electron] Failed to start server:", err);
    const errorMessage =
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    dialog.showErrorBox(
      "Server Error",
      `Failed to start server:\n${errorMessage}`
    );
    await stopMicroserviceAfterServerStartupFailure();
    desktopServiceReadiness = "failed";
    showStartupShell("failed");
    return;
  }

  desktopServiceReadiness = "ready";
  loadTrustedRenderer();

  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-update-channel", () => autoUpdater.channel || "latest");
  ipcMain.handle("set-update-channel", async (_event, channel: string) => {
    if (channel === "stable" || channel === "latest") {
      await saveElectronSettings({ updateChannel: channel });
      autoUpdater.channel = channel;
      console.log(`[Electron] Update channel changed to: ${channel}`);
      return true;
    }
    return false;
  });
  ipcMain.handle("get-auto-update-enabled", () => {
    return electronSettings.autoUpdateEnabled !== false; // Default to true
  });
  ipcMain.handle("set-auto-update-enabled", async (_event, enabled: boolean) => {
    await saveElectronSettings({ autoUpdateEnabled: enabled });
    console.log(`[Electron] Auto-update enabled: ${enabled}`);
    return true;
  });
  registerMpcPreferenceIpcHandlers(ipcMain, app);

  // Moxfield deck fetch handler - uses Chromium's network stack to bypass Cloudflare
  ipcMain.handle("fetch-moxfield-deck", async (_event, deckId: string) => {
    const MOXFIELD_API = "https://api2.moxfield.com/v2";
    const url = `${MOXFIELD_API}/decks/all/${deckId}`;

    console.log(`[Electron/Moxfield] Fetching deck: ${deckId}`);
    console.log(`[Electron/Moxfield] URL: ${url}`);

    try {
      // Use net.fetch which goes through Chromium's network stack
      // This gives us authentic browser TLS fingerprints that Cloudflare accepts
      console.log(
        "[Electron/Moxfield] Using net.fetch (Chromium network stack)"
      );

      const response = await net.fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      console.log(`[Electron/Moxfield] Response status: ${response.status}`);
      console.log(
        `[Electron/Moxfield] Response headers:`,
        Object.fromEntries(response.headers.entries())
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Electron/Moxfield] Error response body: ${errorText.substring(0, 500)}`
        );

        if (response.status === 404) {
          throw new Error("Deck not found. It may be private or deleted.");
        }
        if (response.status === 403) {
          console.error(
            "[Electron/Moxfield] Got 403 - Cloudflare may still be blocking"
          );
          throw new Error(
            "Access denied by Cloudflare. Please try again later."
          );
        }
        throw new Error(
          `Moxfield API error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      console.log(
        `[Electron/Moxfield] Successfully fetched deck: ${data.name || deckId}`
      );
      console.log(
        `[Electron/Moxfield] Card counts - Mainboard: ${data.mainboardCount}, Sideboard: ${data.sideboardCount}`
      );

      return data;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[Electron/Moxfield] Fetch failed: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        console.error(`[Electron/Moxfield] Stack: ${error.stack}`);
      }
      throw error;
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

registerMicroserviceQuitGate(
  app,
  async () => {
    const dispose = disposeCalibrationHarnessIpc;
    disposeCalibrationHarnessIpc = null;
    await dispose?.();
    return microserviceManager?.stop() ?? Promise.resolve();
  },
  {
    logger: (message, error) => {
      if (error === undefined) {
        console.error(message);
      } else {
        console.error(message, error);
      }
    },
  }
);
