import { beforeEach, describe, expect, it, vi } from "vitest";

const searchCards = vi.fn();
const getCardByNameMock = vi.fn();
const getCard = vi.fn();
const getStats = vi.fn();
const health = vi.fn();
const constructorSpy = vi.fn();

vi.mock("@tetrabit/scryfall-cache-client", () => ({
  ScryfallCacheClient: vi.fn().mockImplementation((options) => {
    constructorSpy(options);
    return {
      searchCards,
      getCardByName: getCardByNameMock,
      getCard,
      getStats,
      health,
    };
  }),
}));

describe("scryfallMicroservice", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    searchCards.mockResolvedValue({ data: ["search"] });
    getCardByNameMock.mockResolvedValue({ name: "Sol Ring" });
    getCard.mockResolvedValue({ id: "card-id" });
    getStats.mockResolvedValue({ cards: 42 });
    health.mockResolvedValue({ status: "healthy" });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getMicroserviceUrl: vi.fn().mockResolvedValue("http://127.0.0.1:8181"),
      },
    });
  });

  it("creates and reuses a Scryfall client from the Electron microservice URL", async () => {
    const { getScryfallClient } = await import("./scryfallMicroservice");

    const first = await getScryfallClient();
    const second = await getScryfallClient();

    expect(first).toBe(second);
    expect(window.electronAPI.getMicroserviceUrl).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:8181",
      timeout: 30000,
    });
  });

  it("delegates successful service calls to the cached client", async () => {
    const service = await import("./scryfallMicroservice");

    await expect(service.searchCardsByName("is:commander", 3)).resolves.toEqual(
      {
        data: ["search"],
      }
    );
    expect(searchCards).toHaveBeenCalledWith({ q: "is:commander", page: "3" });

    await expect(service.getCardByName("Sol Ring", "LTC")).resolves.toEqual({
      name: "Sol Ring",
    });
    expect(getCardByNameMock).toHaveBeenCalledWith({
      exact: "Sol Ring",
      set: "LTC",
    });

    await expect(service.getCardByName("Island")).resolves.toEqual({
      name: "Sol Ring",
    });
    expect(getCardByNameMock).toHaveBeenLastCalledWith({ exact: "Island" });

    await expect(service.getCardById("card-id")).resolves.toEqual({
      id: "card-id",
    });
    expect(getCard).toHaveBeenCalledWith("card-id");

    await expect(service.getCacheStats()).resolves.toEqual({ cards: 42 });
    expect(getStats).toHaveBeenCalledTimes(1);

    await expect(service.checkMicroserviceHealth()).resolves.toEqual({
      status: "healthy",
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("logs and rethrows client call failures except health checks", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const service = await import("./scryfallMicroservice");

    searchCards.mockRejectedValueOnce(new Error("search failed"));
    await expect(service.searchCardsByName("bad")).rejects.toThrow(
      "search failed"
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to search cards:",
      expect.any(Error)
    );

    getCardByNameMock.mockRejectedValueOnce(new Error("name failed"));
    await expect(service.getCardByName("bad")).rejects.toThrow("name failed");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to get card by name:",
      expect.any(Error)
    );

    getCard.mockRejectedValueOnce(new Error("id failed"));
    await expect(service.getCardById("bad-id")).rejects.toThrow("id failed");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to get card by ID:",
      expect.any(Error)
    );

    getStats.mockRejectedValueOnce(new Error("stats failed"));
    await expect(service.getCacheStats()).rejects.toThrow("stats failed");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to get cache stats:",
      expect.any(Error)
    );

    health.mockRejectedValueOnce(new Error("offline"));
    await expect(service.checkMicroserviceHealth()).resolves.toEqual({
      status: "unhealthy",
      error: "Error: offline",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Microservice health check failed:",
      expect.any(Error)
    );
  });
});
