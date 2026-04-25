import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardOption } from "@/types";
import type { Image } from "@/db";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { captureMpcCalibrationCase } from "./mpcCalibrationCapture";

describe("mpcCalibrationCapture", () => {
  const card: CardOption = {
    uuid: "card-1",
    name: "Sol Ring",
    order: 1,
    imageId: "image-1",
    isUserUpload: false,
    set: "C21",
    number: "267",
    projectId: "project-1",
  };

  const imageRecord: Image = {
    id: "image-1",
    refCount: 1,
    sourceUrl:
      "https://cards.scryfall.io/normal/front/c/8/c83ed3e0-82d0-4410-a6ca-b0f923eadf83.jpg?1581479572",
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["fixture"], { type: "image/png" }),
    });
  });

  it("freezes source snapshot, candidates, and asset blobs", async () => {
    const result = await captureMpcCalibrationCase({
      datasetId: "dataset-1",
      card,
      imageRecord,
      expectedIdentifier: "candidate-b",
      candidates: [
        {
          identifier: "candidate-a",
          name: "Sol Ring",
          rawName: "Sol Ring [C21] {267}",
          smallThumbnailUrl: "",
          mediumThumbnailUrl: "",
          dpi: 300,
          tags: [],
          sourceName: "Source A",
          source: "source-a",
          extension: "png",
          size: 100,
        },
        {
          identifier: "candidate-b",
          name: "Sol Ring",
          rawName: "Sol Ring (Alt Art)",
          smallThumbnailUrl: "",
          mediumThumbnailUrl: "",
          dpi: 600,
          tags: [],
          sourceName: "Source B",
          source: "source-b",
          extension: "png",
          size: 100,
        },
      ],
    });

    expect(result.caseRecord.expectedIdentifier).toBe("candidate-b");
    expect(result.caseRecord.source.sourceImageUrl).toContain("/normal/");
    expect(result.caseRecord.source.sourceArtImageUrl).toContain("/art_crop/");
    expect(result.caseRecord.candidates[0].imageUrl).toContain("size=small");
    expect(result.assets).toHaveLength(4);
    expect(result.assetErrors).toEqual([]);
  });

  it("captures the case and skips assets that fail to fetch", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["source"], { type: "image/jpeg" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["source-art"], { type: "image/jpeg" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
      });

    const result = await captureMpcCalibrationCase({
      datasetId: "dataset-1",
      card,
      imageRecord,
      expectedIdentifier: "candidate-a",
      candidates: [
        {
          identifier: "candidate-a",
          name: "Sol Ring",
          rawName: "Sol Ring [C21] {267}",
          smallThumbnailUrl: "",
          mediumThumbnailUrl: "",
          dpi: 600,
          tags: [],
          sourceName: "Source A",
          source: "source-a",
          extension: "png",
          size: 100,
        },
      ],
    });

    expect(result.caseRecord.expectedIdentifier).toBe("candidate-a");
    expect(result.assets).toHaveLength(2);
    expect(result.assetErrors).toEqual([
      expect.objectContaining({
        role: "candidate-small",
        candidateIdentifier: "candidate-a",
        message: "Failed to fetch calibration asset: 502",
      }),
    ]);
  });
});
