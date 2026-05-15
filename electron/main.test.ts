import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { MpcPreferenceFixture } from "../shared/types.js";

const appMock = {
  getPath: vi.fn((name: string) =>
    name === "userData" ? "/tmp/proxxied-user-data" : "/tmp"
  ),
  isPackaged: false,
  whenReady: vi.fn(() => ({ then: vi.fn() })),
  on: vi.fn(),
  quit: vi.fn(),
  getVersion: vi.fn(() => "1.0.0"),
};

const ipcMainMock = { handle: vi.fn() };

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }

    webContents = {
      send: vi.fn(),
      openDevTools: vi.fn(),
    };

    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
  },
  ipcMain: ipcMainMock,
  nativeTheme: { themeSource: "system" },
  dialog: { showErrorBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  net: { fetch: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      logger: null,
      channel: "latest",
      on: vi.fn(),
      checkForUpdatesAndNotify: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  },
}));

vi.mock("./microservice-manager.js", () => ({
  createScryfallMicroservice: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  MicroserviceManager: class {},
}));

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: "2026-04-18T12:00:00.000Z",
  cases: [],
};

describe("electron MPC preference helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses userData for the preferences path", async () => {
    const { getMpcPreferencesPath } = await import("./main.ts");

    expect(getMpcPreferencesPath(appMock)).toBe(
      path.join("/tmp/proxxied-user-data", "mpc-preferences.user.json")
    );
    expect(getMpcPreferencesPath()).toBe(
      path.join("/tmp/proxxied-user-data", "mpc-preferences.user.json")
    );
  });

  it("returns null when no preference file exists", async () => {
    const { loadMpcPreferencesFromDisk } = await import("./main.ts");
    const missingFile = path.join(os.tmpdir(), `missing-${Date.now()}.json`);

    await expect(loadMpcPreferencesFromDisk(missingFile)).resolves.toBeNull();
  });

  it("throws when the preference file contains malformed JSON", async () => {
    const { loadMpcPreferencesFromDisk } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-invalid-")
    );
    const filePath = path.join(tempDirectory, "mpc-preferences.user.json");
    await fs.promises.writeFile(filePath, "{bad json", "utf8");

    await expect(loadMpcPreferencesFromDisk(filePath)).rejects.toThrow(
      "[Electron] Failed to load MPC preferences:"
    );

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("writes pretty-printed JSON with a trailing newline", async () => {
    const { saveMpcPreferencesToDisk } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-save-")
    );
    const filePath = path.join(tempDirectory, "mpc-preferences.user.json");

    await saveMpcPreferencesToDisk(fixture, filePath);

    const payload = await fs.promises.readFile(filePath, "utf8");
    expect(payload.endsWith("\n")).toBe(true);
    expect(JSON.parse(payload)).toEqual(fixture);

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("rejects malformed preference fixture shapes with specific errors", async () => {
    const { saveMpcPreferencesToDisk } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-validation-")
    );
    const filePath = path.join(tempDirectory, "mpc-preferences.user.json");
    const baseCase = {
      source: { name: "Card", set: "ABC", collectorNumber: "1" },
      candidates: [
        {
          identifier: "id",
          name: "Card",
          rawName: "Card",
          smallThumbnailUrl: "small",
          mediumThumbnailUrl: "medium",
          imageUrl: "image",
          dpi: 600,
          tags: ["tag"],
          sourceName: "MPC",
          source: "mpc",
          extension: "jpg",
          size: 1,
        },
      ],
      expectedIdentifier: "id",
      notes: "note",
      comparisonHints: { fullCard: { id: 1 }, artMatch: { id: null } },
    };

    await expect(
      saveMpcPreferencesToDisk(null as never, filePath)
    ).rejects.toThrow("not a JSON object");
    await expect(
      saveMpcPreferencesToDisk(
        { exportedAt: "now", cases: [] } as never,
        filePath
      )
    ).rejects.toThrow("missing version");
    await expect(
      saveMpcPreferencesToDisk({ version: 1, cases: [] } as never, filePath)
    ).rejects.toThrow("missing exportedAt");
    await expect(
      saveMpcPreferencesToDisk(
        { version: 1, exportedAt: "now" } as never,
        filePath
      )
    ).rejects.toThrow("missing cases array");
    await expect(
      saveMpcPreferencesToDisk(
        { version: 1, exportedAt: "now", cases: [{}] } as never,
        filePath
      )
    ).rejects.toThrow("malformed case");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [{ ...baseCase, source: { set: 3 } }],
        } as never,
        filePath
      )
    ).rejects.toThrow("malformed source card");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [{ ...baseCase, candidates: {} }],
        } as never,
        filePath
      )
    ).rejects.toThrow("candidates must be an array");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [{ ...baseCase, candidates: [null] }],
        } as never,
        filePath
      )
    ).rejects.toThrow("candidate must be an object");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [
            {
              ...baseCase,
              candidates: [{ ...baseCase.candidates[0], tags: [1] }],
            },
          ],
        } as never,
        filePath
      )
    ).rejects.toThrow("malformed candidate");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [{ ...baseCase, expectedIdentifier: 2 }],
        } as never,
        filePath
      )
    ).rejects.toThrow("malformed case metadata");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [{ ...baseCase, comparisonHints: [] }],
        } as never,
        filePath
      )
    ).rejects.toThrow("malformed comparison hints");
    await expect(
      saveMpcPreferencesToDisk(
        {
          version: 1,
          exportedAt: "now",
          cases: [
            { ...baseCase, comparisonHints: { fullCard: { id: "bad" } } },
          ],
        } as never,
        filePath
      )
    ).rejects.toThrow("malformed comparison hints");

    await saveMpcPreferencesToDisk(
      { version: 1, exportedAt: "now", cases: [baseCase] } as never,
      filePath
    );
    const payload = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    expect(payload.cases[0].comparisonHints.fullCard.id).toBe(1);

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("loads valid preference cases without comparison hints and wraps non-Error read failures", async () => {
    const { loadMpcPreferencesFromDisk } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-no-hints-")
    );
    const filePath = path.join(tempDirectory, "mpc-preferences.user.json");
    const fixtureWithoutHints = {
      version: 1,
      exportedAt: "now",
      cases: [
        {
          source: { name: "Card" },
          candidates: [
            {
              identifier: "id",
              name: "Card",
              rawName: "Card",
              smallThumbnailUrl: "small",
              mediumThumbnailUrl: "medium",
              dpi: 600,
              tags: [],
              sourceName: "MPC",
              source: "mpc",
              extension: "jpg",
              size: 1,
            },
          ],
        },
      ],
    };
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(fixtureWithoutHints),
      "utf8"
    );

    await expect(loadMpcPreferencesFromDisk(filePath)).resolves.toEqual(
      fixtureWithoutHints
    );

    const readSpy = vi
      .spyOn(fs.promises, "readFile")
      .mockRejectedValueOnce("read failed");
    await expect(loadMpcPreferencesFromDisk(filePath)).rejects.toThrow(
      "[Electron] Failed to load MPC preferences: read failed"
    );

    readSpy.mockRestore();
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("cleans up temporary preference writes when atomic rename fails", async () => {
    const { saveMpcPreferencesToDisk } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-rename-")
    );
    const filePath = path.join(tempDirectory, "mpc-preferences.user.json");
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(new Error("rename failed"));
    const unlinkSpy = vi
      .spyOn(fs.promises, "unlink")
      .mockRejectedValueOnce(new Error("unlink failed"));

    await expect(saveMpcPreferencesToDisk(fixture, filePath)).rejects.toThrow(
      "rename failed"
    );
    expect(unlinkSpy).toHaveBeenCalledWith(
      expect.stringContaining("mpc-preferences.user.json.")
    );

    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("executes registered preference IPC handlers", async () => {
    const { registerMpcPreferenceIpcHandlers } = await import("./main.ts");
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "electron-pref-ipc-")
    );
    const ipc = { handle: vi.fn() };
    const appLike = { getPath: vi.fn(() => tempDirectory) };

    registerMpcPreferenceIpcHandlers(ipc, appLike);

    const loadHandler = ipc.handle.mock.calls.find(
      ([channel]) => channel === "mpc-preferences:load"
    )?.[1];
    const saveHandler = ipc.handle.mock.calls.find(
      ([channel]) => channel === "mpc-preferences:save"
    )?.[1];
    await expect(loadHandler()).resolves.toBeNull();
    await saveHandler({}, fixture);
    await expect(loadHandler()).resolves.toEqual(fixture);

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it("registers load and save IPC handlers", async () => {
    const { registerMpcPreferenceIpcHandlers } = await import("./main.ts");

    registerMpcPreferenceIpcHandlers(ipcMainMock, appMock);

    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "mpc-preferences:load",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "mpc-preferences:save",
      expect.any(Function)
    );
  });
});
