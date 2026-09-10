import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  ImageRedirectPolicyError,
  fetchWithPolicyCheckedRedirects,
  type ImageHttpClient,
} from "./imageRedirectPolicy.js";

function clientReturning(...responses: Array<{ status: number; headers?: Record<string, string> }>): ImageHttpClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }),
  } as ImageHttpClient & { get: ReturnType<typeof vi.fn> };
}

const admitScryfall = (value: string): string | undefined => value.startsWith("https://cards.scryfall.io/") ? value : undefined;

describe("bounded image redirect policy", () => {
  it("follows an admitted relative redirect with fresh no-auto-redirect request options", async () => {
    const client = clientReturning(
      { status: 302, headers: { location: "/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png" } },
      { status: 200, headers: {} },
    );
    const requestOptions = vi.fn(() => ({ httpsAgent: {}, maxRedirects: 0, proxy: false as const }));
    const initial = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";
    const redirected = "https://cards.scryfall.io/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png";

    await expect(fetchWithPolicyCheckedRedirects(initial, client, admitScryfall, requestOptions)).resolves.toMatchObject({ status: 200 });

    expect(client.get).toHaveBeenNthCalledWith(1, initial, expect.objectContaining({ maxRedirects: 0, proxy: false }));
    expect(client.get).toHaveBeenNthCalledWith(2, redirected, expect.objectContaining({ maxRedirects: 0, proxy: false }));
    expect(requestOptions).toHaveBeenCalledTimes(2);
    expect(requestOptions.mock.results[0].value).not.toBe(requestOptions.mock.results[1].value);
  });

  it("rejects an unadmitted redirect before a connection to its destination", async () => {
    const client = clientReturning({ status: 302, headers: { location: "https://evil.example/image.png" } });
    const initial = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";

    await expect(fetchWithPolicyCheckedRedirects(initial, client, admitScryfall, () => ({ maxRedirects: 0, proxy: false as const })))
      .rejects.toBeInstanceOf(ImageRedirectPolicyError);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenLastCalledWith(initial, expect.any(Object));
  });

  it("rejects missing locations, loops, and a fourth redirect", async () => {
    const initial = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";
    const options = () => ({ maxRedirects: 0, proxy: false as const });

    await expect(fetchWithPolicyCheckedRedirects(initial, clientReturning({ status: 301, headers: {} }), admitScryfall, options))
      .rejects.toThrow("Location");

    const loopClient = clientReturning(
      { status: 301, headers: { location: "/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png" } },
      { status: 301, headers: { location: initial } },
    );
    await expect(fetchWithPolicyCheckedRedirects(initial, loopClient, admitScryfall, options)).rejects.toThrow("loop");
    expect(loopClient.get).toHaveBeenCalledTimes(2);

    const redirects = clientReturning(
      { status: 301, headers: { location: "/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png" } },
      { status: 302, headers: { location: "/png/front/c/d/cd123456-1234-1234-1234-123456789abc.png" } },
      { status: 303, headers: { location: "/png/front/d/e/de123456-1234-1234-1234-123456789abc.png" } },
      { status: 307, headers: { location: "/png/front/e/f/ef123456-1234-1234-1234-123456789abc.png" } },
    );
    await expect(fetchWithPolicyCheckedRedirects(initial, redirects, admitScryfall, options)).rejects.toThrow("maximum");
    expect(redirects.get).toHaveBeenCalledTimes(4);
  });

  it("settles a redirect response stream before issuing the admitted next hop", async () => {
    const initial = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";
    const redirectBody = Readable.from([Buffer.from("redirect body")]);
    let calls = 0;
    const client: ImageHttpClient = {
      get: vi.fn(async () => {
        calls++;
        if (calls === 1) return { status: 302, data: redirectBody, headers: { location: "/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png" } } as never;
        expect(redirectBody.destroyed).toBe(true);
        return { status: 200, headers: {} } as never;
      }),
    };

    await expect(fetchWithPolicyCheckedRedirects(initial, client, admitScryfall, () => ({ maxRedirects: 0, proxy: false as const }))).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });
});
