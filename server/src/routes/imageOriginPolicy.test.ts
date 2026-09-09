import { describe, expect, it } from "vitest";
import { validateMpcRequest, validateProxyTarget } from "./imageOriginPolicy.js";

const validScryfall = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png?1562820261";
const validThumbnail = "https://drive.google.com/thumbnail?id=Drive_ID-123&sz=w400-h400";

describe("image proxy origin policy", () => {
  it("accepts only the documented Scryfall and legacy Drive thumbnail forms", () => {
    expect(validateProxyTarget(validScryfall)).toEqual({ ok: true, url: validScryfall });
    expect(validateProxyTarget(validThumbnail)).toEqual({ ok: true, url: validThumbnail });
    expect(validateProxyTarget("https://cards.scryfall.io:443/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png"))
      .toEqual({ ok: true, url: "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png" });
    expect(validateProxyTarget("https://drive.google.com/thumbnail?sz=w800-h800&id=Drive_ID-123"))
      .toEqual({ ok: true, url: "https://drive.google.com/thumbnail?sz=w800-h800&id=Drive_ID-123" });
  });

  it.each([
    "",
    "/relative.png",
    "//cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "http://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "file:///etc/passwd",
    "data:image/png;base64,abc",
    "blob:https://cards.scryfall.io/id",
    "javascript:alert(1)",
    "https://user@cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io@evil.example/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io.evil.example/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://127.0.0.1/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://[::1]/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io:444/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io/normal/front/a/b/ab123456-1234-1234-1234-123456789abc.jpg?name=value",
    "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png?",
    "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png?123&456",
    "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png#fragment",
    "https://cards.scryfall.io/%70ng/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io/png/front/a/c/ab123456-1234-1234-1234-123456789abc.png",
    "https://drive.google.com/thumbnail?id=Drive_ID-123&id=other&sz=w400-h400",
    "https://drive.google.com/thumbnail?id=Drive_ID-123&sz=w600-h600",
    "https://drive.google.com/thumbnail?id=Drive_ID-123&sz=w400-h800",
    " https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io/png/front/a/c/../b/ab123456-1234-1234-1234-123456789abc.png",
    "https://cards.scryfall.io\\png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
    "https://drive.google.com/uc?export=download&id=Drive_ID-123",
    "https%253A%252F%252Fcards.scryfall.io%252Fpng%252Ffront%252Fa%252Fb%252Fab123456-1234-1234-1234-123456789abc.png",
  ])("rejects unsupported or ambiguous proxy target %s", (target) => {
    expect(validateProxyTarget(target)).toEqual({ ok: false });
  });

  it("rejects non-string query values", () => {
    expect(validateProxyTarget([validScryfall])).toEqual({ ok: false });
    expect(validateProxyTarget(undefined)).toEqual({ ok: false });
  });

  it("accepts only valid MPC identifiers and the closed size enum", () => {
    expect(validateMpcRequest("Drive_ID-123", "full")).toEqual({ ok: true, id: "Drive_ID-123", size: "full" });
    expect(validateMpcRequest("Drive_ID-123", undefined)).toEqual({ ok: true, id: "Drive_ID-123", size: "full" });
    expect(validateMpcRequest("Drive_ID-123", "small")).toEqual({ ok: true, id: "Drive_ID-123", size: "small" });
    expect(validateMpcRequest("Drive_ID-123", "large")).toEqual({ ok: true, id: "Drive_ID-123", size: "large" });
    expect(validateMpcRequest("bad/id", "full")).toEqual({ ok: false });
    expect(validateMpcRequest("Drive_ID-123", "unexpected")).toEqual({ ok: false });
    expect(validateMpcRequest(["Drive_ID-123"], "full")).toEqual({ ok: false });
  });
});
