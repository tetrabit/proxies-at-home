import { describe, expect, it, vi } from "vitest";
import https from "https";
import {
  AddressPolicyError,
  createPinnedHttpsAgent,
  isPublicIpAddress,
  type ResolveAll,
} from "./imageConnectionPolicy.js";

function lookupThroughAgent(agent: https.Agent, hostname: string): Promise<{ address: string; family: number }> {
  const lookup = agent.options.lookup as (
    hostname: string,
    options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void,
  ) => void;

  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (error, address, family) => {
      if (error || !address || !family) {
        reject(error ?? new Error("lookup did not return a pinned address"));
        return;
      }
      resolve({ address, family });
    });
  });
}

function resolverReturning(records: Array<{ address: string; family: number }>): ResolveAll {
  return (_hostname, _options, callback) => callback(null, records);
}

describe("image connection-time address policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::10.0.0.1",
    "2002:0a00:0001::0808:0808",
  ])("rejects non-global address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("accepts globally routable address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it("fails closed before connecting when any DNS answer is prohibited", async () => {
    const resolveAll = vi.fn(resolverReturning([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]));
    const agent = createPinnedHttpsAgent({ resolveAll });

    await expect(lookupThroughAgent(agent, "cards.scryfall.io")).rejects.toBeInstanceOf(AddressPolicyError);
    expect(resolveAll).toHaveBeenCalledWith(
      "cards.scryfall.io",
      { all: true, verbatim: true },
      expect.any(Function),
    );
  });

  it("pins the socket lookup to a public address while retaining the requested hostname", async () => {
    const resolveAll = vi.fn(resolverReturning([{ address: "2001:4860:4860::8888", family: 6 }]));
    const agent = createPinnedHttpsAgent({ resolveAll });

    await expect(lookupThroughAgent(agent, "cards.scryfall.io")).resolves.toEqual({
      address: "2001:4860:4860::8888",
      family: 6,
    });
    expect(agent.options.servername).toBeUndefined();
    expect(resolveAll).toHaveBeenCalledWith(
      "cards.scryfall.io",
      { all: true, verbatim: true },
      expect.any(Function),
    );
  });

  it("revalidates a rebinding hostname at the socket lookup rather than retaining a prior approval", async () => {
    const resolveAll = vi
      .fn<ResolveAll>()
      .mockImplementationOnce(resolverReturning([{ address: "8.8.8.8", family: 4 }]))
      .mockImplementationOnce(resolverReturning([{ address: "::ffff:10.0.0.1", family: 6 }]));
    const agent = createPinnedHttpsAgent({ resolveAll });

    await expect(lookupThroughAgent(agent, "cards.scryfall.io")).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(lookupThroughAgent(agent, "cards.scryfall.io")).rejects.toBeInstanceOf(AddressPolicyError);
    expect(resolveAll).toHaveBeenCalledTimes(2);
  });
});
