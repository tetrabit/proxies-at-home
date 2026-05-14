import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectsGet: vi.fn(),
  cardsWhere: vi.fn(),
  userImagesGet: vi.fn(),
  userImagesPut: vi.fn(),
  projectsAdd: vi.fn(),
  cardsBulkAdd: vi.fn(),
  transaction: vi.fn(),
  inferImageSource: vi.fn(),
}));

vi.mock("@/constants", () => ({ API_BASE: "http://api.test" }));
vi.mock("../db", () => ({
  db: {
    projects: { get: mocks.projectsGet, add: mocks.projectsAdd },
    cards: { where: mocks.cardsWhere, bulkAdd: mocks.cardsBulkAdd },
    user_images: { get: mocks.userImagesGet, put: mocks.userImagesPut },
    transaction: mocks.transaction,
  },
}));
vi.mock("./imageSourceUtils", () => ({
  inferImageSource: mocks.inferImageSource,
}));

import {
  deleteServerBackup,
  downloadBackup,
  exportProject,
  fetchServerBackup,
  importProject,
  listServerBackups,
  pickBackupFile,
  validateBackup,
  type ProjectBackup,
} from "./projectBackup";

const validBackup: ProjectBackup = {
  version: 1,
  exportedAt: "2026-04-04T12:00:00.000Z",
  app: "proxxied",
  project: {
    name: "Test Project",
    createdAt: 100,
    settings: { columns: 3 },
  },
  cards: [],
  userImages: [],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("projectBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    mocks.transaction.mockImplementation(
      async (_mode, _projects, _cards, callback) => callback()
    );
    mocks.cardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ sortBy: vi.fn().mockResolvedValue([]) })),
    });
    mocks.inferImageSource.mockReturnValue("custom");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backup");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("project-new")
      .mockReturnValueOnce("front-new")
      .mockReturnValueOnce("back-new")
      .mockReturnValue("uuid-next");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("validateBackup", () => {
    it("accepts a valid backup", () => {
      expect(() => validateBackup(validBackup)).not.toThrow();
      expect(validateBackup(validBackup)).toEqual(validBackup);
    });

    it("rejects invalid envelopes", () => {
      expect(() => validateBackup(null)).toThrow("not a JSON object");
      expect(() => validateBackup(undefined)).toThrow("not a JSON object");
      expect(() => validateBackup({ ...validBackup, app: "other" })).toThrow(
        "not a Proxxied backup"
      );
      expect(() => validateBackup({ ...validBackup, version: "1" })).toThrow(
        "Unsupported backup version"
      );
      expect(() => validateBackup({ ...validBackup, version: 999 })).toThrow(
        "Unsupported backup version"
      );
      const { project: _project, ...noProject } = validBackup;
      expect(() => validateBackup(noProject)).toThrow(
        "missing project metadata"
      );
      expect(() => validateBackup({ ...validBackup, project: "bad" })).toThrow(
        "missing project metadata"
      );
      const { cards: _cards, ...noCards } = validBackup;
      expect(() => validateBackup(noCards)).toThrow("missing cards array");
    });
  });

  it("exports project cards and only custom uploaded image blobs", async () => {
    mocks.projectsGet.mockResolvedValue({
      id: "p1",
      name: "Deck/One",
      createdAt: 10,
      settings: { rows: 3 },
    });
    mocks.cardsWhere.mockReturnValue({
      equals: vi.fn(() => ({
        sortBy: vi.fn().mockResolvedValue([
          {
            uuid: "front",
            name: "Front",
            order: 0,
            imageId: "hash-custom",
            isUserUpload: true,
            linkedBackId: "back",
            overrides: { brightness: 1 },
            token_parts: [{ name: "Token" }],
            needs_token: true,
          },
          {
            uuid: "remote",
            name: "Remote",
            order: 1,
            imageId: "remote-id",
            isUserUpload: true,
          },
          {
            uuid: "normal",
            name: "Normal",
            order: 2,
            imageId: "scryfall",
            isUserUpload: false,
          },
        ]),
      })),
    });
    mocks.inferImageSource.mockImplementation((id) =>
      id === "hash-custom" ? "custom" : "scryfall"
    );
    mocks.userImagesGet.mockResolvedValue({
      hash: "hash-custom",
      type: "text/plain",
      data: new Blob(["hello"], { type: "text/plain" }),
    });

    const backup = await exportProject("p1");

    expect(backup.project).toEqual({
      name: "Deck/One",
      createdAt: 10,
      settings: { rows: 3 },
    });
    expect(backup.cards).toHaveLength(3);
    expect(backup.cards[0]).toMatchObject({
      uuid: "front",
      linkedBackId: "back",
      needs_token: true,
    });
    expect(backup.userImages).toEqual([
      { hash: "hash-custom", type: "text/plain", data: "aGVsbG8=" },
    ]);
    expect(mocks.userImagesGet).toHaveBeenCalledTimes(1);
  });

  it("stores an empty base64 payload when FileReader returns no data URL comma", async () => {
    class BareFileReader {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = vi.fn(() => {
        this.result = "not-a-data-url";
        this.onloadend?.();
      });
    }
    vi.stubGlobal("FileReader", BareFileReader);
    mocks.projectsGet.mockResolvedValue({
      id: "p1",
      name: "Deck",
      createdAt: 10,
      settings: {},
    });
    mocks.cardsWhere.mockReturnValue({
      equals: vi.fn(() => ({
        sortBy: vi
          .fn()
          .mockResolvedValue([
            {
              uuid: "c",
              name: "C",
              order: 0,
              imageId: "hash",
              isUserUpload: true,
            },
          ]),
      })),
    });
    mocks.userImagesGet.mockResolvedValue({
      hash: "hash",
      type: "text/plain",
      data: new Blob(["hello"]),
    });

    await expect(exportProject("p1")).resolves.toMatchObject({
      userImages: [{ hash: "hash", type: "text/plain", data: "" }],
    });
  });

  it("throws when exporting a missing project and skips missing custom blobs", async () => {
    mocks.projectsGet.mockResolvedValueOnce(undefined);
    await expect(exportProject("missing")).rejects.toThrow(
      "Project missing not found"
    );

    mocks.projectsGet.mockResolvedValueOnce({
      id: "p1",
      name: "Deck",
      createdAt: 10,
      settings: {},
    });
    mocks.cardsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({
        sortBy: vi.fn().mockResolvedValue([
          {
            uuid: "c",
            name: "C",
            order: 0,
            imageId: "hash",
            isUserUpload: true,
          },
        ]),
      })),
    });
    mocks.userImagesGet.mockResolvedValueOnce(undefined);
    await expect(exportProject("p1")).resolves.toMatchObject({
      userImages: [],
    });
  });

  it("downloads backup JSON with a sanitized date-stamped filename and revokes the URL", () => {
    const link = document.createElement("a");
    const click = vi.spyOn(link, "click").mockImplementation(() => undefined);
    vi.spyOn(document, "createElement").mockReturnValue(link);

    downloadBackup({
      ...validBackup,
      project: {
        ...validBackup.project,
        name: "A bad/name that is much too long ".repeat(4),
      },
    });

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(link.download).toMatch(
      /^proxxied_A_bad_name_that_is_much_too_long_A_bad_name_that_is_much_too_2026-05-14\.json$/
    );
    expect(click).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:backup");
  });

  it("imports projects with image restore, idempotent images, remapped DFC links, and default names", async () => {
    mocks.userImagesGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ hash: "existing" });
    const backup: ProjectBackup = {
      ...validBackup,
      project: {
        ...validBackup.project,
        name: "Imported Deck",
        settings: undefined as any,
      },
      userImages: [
        { hash: "new-img", type: "text/plain", data: "aGVsbG8=" },
        { hash: "existing", type: "text/plain", data: "eA==" },
      ],
      cards: [
        {
          uuid: "front-old",
          name: "Front",
          order: 0,
          imageId: "remote",
          isUserUpload: false,
          linkedBackId: "back-old",
        },
        {
          uuid: "back-old",
          name: "Back",
          order: 1,
          imageId: "local",
          isUserUpload: true,
          linkedFrontId: "front-old",
        },
      ],
    };

    await expect(importProject(backup)).resolves.toBe("project-new");

    expect(mocks.userImagesPut).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: "new-img",
        type: "text/plain",
        data: expect.any(Blob),
      })
    );
    expect(mocks.projectsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "project-new",
        name: "Imported Deck (Imported)",
        cardCount: 1,
        settings: {},
      })
    );
    expect(mocks.cardsBulkAdd).toHaveBeenCalledWith([
      expect.objectContaining({
        uuid: "front-new",
        projectId: "project-new",
        linkedBackId: "back-new",
        needsEnrichment: true,
      }),
      expect.objectContaining({
        uuid: "back-new",
        projectId: "project-new",
        linkedFrontId: "front-new",
        needsEnrichment: false,
      }),
    ]);
  });

  it("imports projects with an explicit name", async () => {
    await expect(importProject(validBackup, "Chosen")).resolves.toBe(
      "project-new"
    );
    expect(mocks.projectsAdd).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Chosen", settings: { columns: 3 } })
    );
  });

  describe("pickBackupFile", () => {
    it("resolves parsed backups from selected JSON files", async () => {
      const input = document.createElement("input") as HTMLInputElement;
      vi.spyOn(input, "click").mockImplementation(() => {
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [{ text: async () => JSON.stringify(validBackup) }],
        });
        void input.onchange?.(new Event("change"));
      });
      vi.spyOn(document, "createElement").mockReturnValue(input);

      await expect(pickBackupFile()).resolves.toEqual(validBackup);
      expect(input.type).toBe("file");
      expect(input.accept).toBe(".json,application/json");
    });

    it("resolves null for empty selections, cancel events, and focus fallback cancellation", async () => {
      const input = document.createElement("input") as HTMLInputElement;
      vi.spyOn(input, "click").mockImplementation(
        () => void input.onchange?.(new Event("change"))
      );
      vi.spyOn(document, "createElement").mockReturnValueOnce(input);
      await expect(pickBackupFile()).resolves.toBeNull();

      const cancelInput = document.createElement("input") as HTMLInputElement;
      vi.spyOn(cancelInput, "click").mockImplementation(
        () => void cancelInput.oncancel?.(new Event("cancel"))
      );
      vi.spyOn(document, "createElement").mockReturnValueOnce(cancelInput);
      await expect(pickBackupFile()).resolves.toBeNull();

      const focusInput = document.createElement("input") as HTMLInputElement;
      vi.spyOn(focusInput, "click").mockImplementation(() =>
        window.dispatchEvent(new Event("focus"))
      );
      vi.spyOn(document, "createElement").mockReturnValueOnce(focusInput);
      const promise = pickBackupFile();
      await vi.advanceTimersByTimeAsync(300);
      await expect(promise).resolves.toBeNull();
    });

    it("rejects invalid JSON and non-Error read failures", async () => {
      const badInput = document.createElement("input") as HTMLInputElement;
      vi.spyOn(badInput, "click").mockImplementation(() => {
        Object.defineProperty(badInput, "files", {
          configurable: true,
          value: [{ text: async () => "{" }],
        });
        void badInput.onchange?.(new Event("change"));
      });
      vi.spyOn(document, "createElement").mockReturnValueOnce(badInput);
      await expect(pickBackupFile()).rejects.toBeInstanceOf(Error);

      const throwInput = document.createElement("input") as HTMLInputElement;
      vi.spyOn(throwInput, "click").mockImplementation(() => {
        Object.defineProperty(throwInput, "files", {
          configurable: true,
          value: [
            {
              text: async () => {
                throw "boom";
              },
            },
          ],
        });
        void throwInput.onchange?.(new Event("change"));
      });
      vi.spyOn(document, "createElement").mockReturnValueOnce(throwInput);
      await expect(pickBackupFile()).rejects.toThrow("boom");
    });
  });

  describe("server backup API helpers", () => {
    it("lists, fetches, and deletes server backups on successful responses", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ backups: [{ projectId: "p1" }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: validBackup }),
        } as Response)
        .mockResolvedValueOnce({ ok: true } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      await expect(listServerBackups()).resolves.toEqual([{ projectId: "p1" }]);
      await expect(fetchServerBackup("p1")).resolves.toEqual(validBackup);
      await expect(deleteServerBackup("p1")).resolves.toBeUndefined();
      await expect(deleteServerBackup("missing")).resolves.toBeUndefined();
      expect(fetch).toHaveBeenNthCalledWith(1, "http://api.test/api/backup");
      expect(fetch).toHaveBeenNthCalledWith(2, "http://api.test/api/backup/p1");
      expect(fetch).toHaveBeenNthCalledWith(
        3,
        "http://api.test/api/backup/p1",
        { method: "DELETE" }
      );
    });

    it("throws helpful server API errors", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: false } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      await expect(listServerBackups()).rejects.toThrow(
        "Failed to list server backups"
      );
      await expect(fetchServerBackup("missing")).rejects.toThrow(
        "Backup not found on server"
      );
      await expect(fetchServerBackup("p1")).rejects.toThrow(
        "Failed to fetch backup from server"
      );
      await expect(deleteServerBackup("p1")).rejects.toThrow(
        "Failed to delete backup"
      );
    });
  });
});
