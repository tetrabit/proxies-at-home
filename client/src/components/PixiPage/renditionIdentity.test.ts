import { describe, expect, it, vi } from "vitest";
import { RENDITION_IDENTITY_CHUNK_BYTES, createRenditionIdentityAdmission } from "./renditionIdentity";

describe("RenditionIdentityAdmission", () => {
  it("gives equivalent re-deserialized blobs the same bounded content identity", async () => {
    const admission = createRenditionIdentityAdmission();

    await expect(admission.identify(new Blob(["same pixels"], { type: "image/png" }))).resolves.toBe(
      await admission.identify(new Blob(["same pixels"], { type: "image/png" })),
    );
  });

  it("distinguishes same-size blobs with identical edges and changed middle content", async () => {
    const admission = createRenditionIdentityAdmission();
    const edge = new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES).fill(7);
    const firstMiddle = new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES).fill(11);
    const changedMiddle = new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES).fill(12);

    const first = await admission.identify(new Blob([edge, firstMiddle, edge], { type: "image/png" }));
    const changed = await admission.identify(new Blob([edge, changedMiddle, edge], { type: "image/png" }));

    expect(first).not.toBe(changed);
  });

  it("reads the complete content in bounded chunks", async () => {
    const admission = createRenditionIdentityAdmission();
    const blob = new Blob([new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES * 3)]);
    const slice = vi.spyOn(blob, "slice");

    await admission.identify(blob);

    expect(slice).toHaveBeenCalledWith(0, RENDITION_IDENTITY_CHUNK_BYTES);
    expect(slice).toHaveBeenCalledWith(RENDITION_IDENTITY_CHUNK_BYTES, RENDITION_IDENTITY_CHUNK_BYTES * 2);
    expect(slice).toHaveBeenCalledWith(RENDITION_IDENTITY_CHUNK_BYTES * 2, blob.size);
    expect(slice).toHaveBeenCalledTimes(3);
  });

  it("retries an identity after a transient content-read failure", async () => {
    const admission = createRenditionIdentityAdmission();
    const blob = new Blob(["retryable content"]);
    vi.spyOn(blob, "slice").mockImplementationOnce(() => {
      throw new Error("temporary read failure");
    });

    await expect(admission.identify(blob)).rejects.toThrow("temporary read failure");
    await expect(admission.identify(blob)).resolves.toContain("rendition-probabilistic-full-fnv1a64-v2");
  });
});
