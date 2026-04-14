import { describe, expect, it } from "vitest";

import {
  computeColorProfile,
  computeColorProfileSimilarity,
} from "./mpcColorScoring";

describe("mpcColorScoring", () => {
  it("returns a perfect score for identical profiles", () => {
    const channels = [
      new Float32Array([1, 1, 1, 1]),
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([0, 0, 0, 0]),
    ];

    const profile = computeColorProfile(channels);
    expect(computeColorProfileSimilarity(profile, profile)).toBe(1);
  });

  it("scores different color palettes lower than similar ones", () => {
    const warmProfile = computeColorProfile([
      new Float32Array([0.9, 0.85, 0.8, 0.88]),
      new Float32Array([0.3, 0.25, 0.2, 0.28]),
      new Float32Array([0.1, 0.08, 0.05, 0.1]),
    ]);
    const warmVariantProfile = computeColorProfile([
      new Float32Array([0.86, 0.83, 0.79, 0.84]),
      new Float32Array([0.28, 0.22, 0.18, 0.24]),
      new Float32Array([0.11, 0.09, 0.06, 0.11]),
    ]);
    const coolProfile = computeColorProfile([
      new Float32Array([0.1, 0.12, 0.08, 0.09]),
      new Float32Array([0.25, 0.28, 0.22, 0.24]),
      new Float32Array([0.85, 0.88, 0.82, 0.9]),
    ]);

    const similarScore = computeColorProfileSimilarity(
      warmProfile,
      warmVariantProfile
    );
    const differentScore = computeColorProfileSimilarity(
      warmProfile,
      coolProfile
    );

    expect(similarScore).toBeGreaterThan(differentScore);
    expect(similarScore).toBeGreaterThan(0.9);
    expect(differentScore).toBeLessThan(0.5);
  });
});
