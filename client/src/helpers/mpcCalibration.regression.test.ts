import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateMpcCalibrationFixture } from "./mpcCalibrationImport";
import { evaluateMpcCalibrationDataset } from "./mpcCalibrationRunner";

function loadFixture() {
  const fixturePath = path.resolve(
    process.cwd(),
    "tests/fixtures/mpc-calibration-regression.v1.json"
  );
  return validateMpcCalibrationFixture(
    JSON.parse(readFileSync(fixturePath, "utf8"))
  );
}

describe("mpc calibration regression fixture", () => {
  it("replays the canonical dataset deterministically", async () => {
    const fixture = loadFixture();

    const result = await evaluateMpcCalibrationDataset(
      fixture.dataset,
      fixture.cases,
      { id: "regression" }
    );

    expect(result.summary.totalCases).toBe(9);
    expect(result.summary.matchedCases).toBe(9);
    expect(result.summary.accuracy).toBe(1);
  });
});
