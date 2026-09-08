import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const post = vi.fn();
  const enqueue = vi.fn(<T>(operation: () => Promise<T>) => operation());
  return {
    get,
    post,
    enqueue,
    lookupCardByName: vi.fn(),
    lookupCardBySetNumber: vi.fn(),
    insertOrUpdateCard: vi.fn(),
  };
});

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({ get: mocks.get, post: mocks.post })),
  },
  create: vi.fn(() => ({ get: mocks.get, post: mocks.post })),
}));

vi.mock("../db/proxxiedCardLookup.js", () => ({
  lookupCardByName: mocks.lookupCardByName,
  lookupCardBySetNumber: mocks.lookupCardBySetNumber,
  insertOrUpdateCard: mocks.insertOrUpdateCard,
}));

vi.mock("./scryfallRequestBroker.js", () => ({
  scryfallRequestBroker: { enqueue: mocks.enqueue },
}));

import { batchFetchCards } from "./getCardImagesPaged.js";

describe("getCardImagesPaged broker dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookupCardByName.mockReturnValue(null);
  });

  it("enqueues the failed token batch and each retry as separate physical requests", async () => {
    mocks.get
      .mockRejectedValueOnce(new Error("batch rejected"))
      .mockResolvedValueOnce({ data: { data: [{ id: "goblin", name: "Goblin" }] } })
      .mockResolvedValueOnce({ data: { data: [] } });

    const cards = await batchFetchCards([
      { name: "Goblin", isToken: true },
      { name: "Soldier", isToken: true },
    ]);

    expect(cards.get("goblin")).toMatchObject({ id: "goblin" });
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.enqueue).toHaveBeenCalledTimes(3);
    expect(new Set(mocks.enqueue.mock.calls.map(([operation]) => operation))).toHaveLength(3);
  });

  it("enqueues a collection batch as one physical direct request", async () => {
    mocks.post.mockResolvedValue({ data: { data: [{ id: "sol", name: "Sol Ring" }], not_found: [] } });

    const cards = await batchFetchCards([{ name: "Sol Ring" }, { name: "Island" }]);

    expect(cards.get("sol ring")).toMatchObject({ id: "sol" });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
