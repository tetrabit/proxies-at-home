import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMethods = {
  searchCards: vi.fn(),
  getCardByName: vi.fn(),
  getCard: vi.fn(),
  getStats: vi.fn(),
  health: vi.fn(),
};

const ScryfallCacheClient = vi.fn(() => clientMethods);

vi.mock("@tetrabit/scryfall-cache-client", () => ({
  ScryfallCacheClient,
}));

const loadModule = async () => {
  vi.resetModules();
  return await import("./scryfallMicroservice");
};

describe("scryfallMicroservice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(clientMethods).forEach((method) => method.mockReset());
    vi.stubGlobal("window", {
      electronAPI: {
        getMicroserviceUrl: vi.fn().mockResolvedValue("http://127.0.0.1:4567"),
      },
    });
  });

  it("creates and reuses a client discovered from Electron", async () => {
    const { getScryfallClient } = await loadModule();

    const first = await getScryfallClient();
    const second = await getScryfallClient();

    expect(first).toBe(clientMethods);
    expect(second).toBe(first);
    expect(window.electronAPI.getMicroserviceUrl).toHaveBeenCalledTimes(1);
    expect(ScryfallCacheClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4567",
      timeout: 30000,
    });
  });

  it("delegates successful card operations to the cache client", async () => {
    const mod = await loadModule();
    clientMethods.searchCards.mockResolvedValue({ data: ["search"] });
    clientMethods.getCardByName.mockResolvedValue({ name: "Island" });
    clientMethods.getCard.mockResolvedValue({ id: "card-id" });
    clientMethods.getStats.mockResolvedValue({ cards: 7 });
    clientMethods.health.mockResolvedValue({ status: "healthy" });

    await expect(mod.searchCardsByName("island", 3)).resolves.toEqual({ data: ["search"] });
    await expect(mod.getCardByName("Island", "lea")).resolves.toEqual({ name: "Island" });
    await expect(mod.getCardByName("Forest")).resolves.toEqual({ name: "Island" });
    await expect(mod.getCardById("card-id")).resolves.toEqual({ id: "card-id" });
    await expect(mod.getCacheStats()).resolves.toEqual({ cards: 7 });
    await expect(mod.checkMicroserviceHealth()).resolves.toEqual({ status: "healthy" });

    expect(clientMethods.searchCards).toHaveBeenCalledWith({ q: "island", page: "3" });
    expect(clientMethods.getCardByName).toHaveBeenNthCalledWith(1, { exact: "Island", set: "lea" });
    expect(clientMethods.getCardByName).toHaveBeenNthCalledWith(2, { exact: "Forest" });
    expect(clientMethods.getCard).toHaveBeenCalledWith("card-id");
    expect(clientMethods.getStats).toHaveBeenCalledTimes(1);
    expect(clientMethods.health).toHaveBeenCalledTimes(1);
  });

  it("logs and rethrows operation failures but converts health failures", async () => {
    const mod = await loadModule();
    const error = new Error("offline");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    clientMethods.searchCards.mockRejectedValueOnce(error);
    clientMethods.getCardByName.mockRejectedValueOnce(error);
    clientMethods.getCard.mockRejectedValueOnce(error);
    clientMethods.getStats.mockRejectedValueOnce(error);
    clientMethods.health.mockRejectedValueOnce(error);

    await expect(mod.searchCardsByName("bad")).rejects.toThrow("offline");
    await expect(mod.getCardByName("bad")).rejects.toThrow("offline");
    await expect(mod.getCardById("bad-id")).rejects.toThrow("offline");
    await expect(mod.getCacheStats()).rejects.toThrow("offline");
    await expect(mod.checkMicroserviceHealth()).resolves.toEqual({
      status: "unhealthy",
      error: "Error: offline",
    });

    expect(consoleError).toHaveBeenCalledTimes(5);
    consoleError.mockRestore();
  });
});
