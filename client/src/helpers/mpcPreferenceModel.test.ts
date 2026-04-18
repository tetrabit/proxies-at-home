import { describe, expect, it } from "vitest";
import type { MpcCalibrationCaseRecord } from "@/db";
import {
  buildBootstrappedSourcePreferenceDataset,
  buildMpcPreferenceScoreMap,
  evaluateHeldOutPreferenceModel,
  trainMpcPreferenceModel,
} from "./mpcPreferenceModel";

function makeCandidate(
  overrides: Partial<MpcCalibrationCaseRecord["candidates"][number]>
) {
  return {
    identifier: overrides.identifier ?? crypto.randomUUID(),
    name: overrides.name ?? "Windborn Muse",
    rawName: overrides.rawName ?? overrides.name ?? "Windborn Muse",
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
    imageUrl: "fixture://candidate",
    dpi: overrides.dpi ?? 800,
    tags: overrides.tags ?? [],
    sourceName: overrides.sourceName ?? "Chilli_Axe",
    source: overrides.source ?? overrides.sourceName ?? "Chilli_Axe",
    extension: "png",
    size: 100,
  };
}

function makeCase(
  name: string,
  expectedSource: string,
  otherSource: string
): MpcCalibrationCaseRecord {
  const expected = makeCandidate({
    identifier: `${name}-expected`,
    name,
    rawName: `${name} (Preferred)`,
    sourceName: expectedSource,
    source: expectedSource,
    tags: [],
    dpi: 800,
  });
  const other = makeCandidate({
    identifier: `${name}-other`,
    name,
    rawName: `${name} [SET] {1}`,
    sourceName: otherSource,
    source: otherSource,
    tags: ["Borderless"],
    dpi: 1200,
  });

  return {
    id: crypto.randomUUID(),
    datasetId: "dataset",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: { name },
    candidates: [expected, other],
    expectedIdentifier: expected.identifier,
  };
}

describe("mpcPreferenceModel", () => {
  it("trains source and formatting preferences from calibration cases", () => {
    const cases = [
      makeCase("Windborn Muse", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Talrand, Sky Summoner", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Thassa, Deep-Dwelling", "Chilli_Axe", "Hathwellcrisping"),
    ];

    const model = trainMpcPreferenceModel(cases, {
      emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
      minCaseCount: 1,
    });

    expect(model).not.toBeNull();
    expect(model?.trainingCaseCount).toBe(3);

    const ranked = buildMpcPreferenceScoreMap(model!, cases[0].candidates);
    expect(ranked[cases[0].expectedIdentifier!]).toBeGreaterThan(
      ranked[cases[0].candidates[1].identifier]
    );
  });

  it("trains across all card types and colors with Hathwellcrisping preference", () => {
    const cases = [
      // White creatures
      makeCase("Thalia, Guardian of Thraben", "Hathwellcrisping", "JohnPrime"),
      makeCase("Sun Titan", "Hathwellcrisping", "WillieTanner"),
      makeCase("Elesh Norn, Grand Cenobite", "Hathwellcrisping", "MrTeferi"),
      // Blue creatures
      makeCase("Snapcaster Mage", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Consecrated Sphinx", "Hathwellcrisping", "MrTeferi"),
      // Black creatures
      makeCase("Sheoldred, the Apocalypse", "Hathwellcrisping", "JohnPrime"),
      makeCase("Grave Titan", "Hathwellcrisping", "WillieTanner"),
      // Red creatures
      makeCase("Dockside Extortionist", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Etali, Primal Storm", "Hathwellcrisping", "MrTeferi"),
      // Green creatures
      makeCase("Craterhoof Behemoth", "Hathwellcrisping", "JohnPrime"),
      makeCase("Vorinclex, Voice of Hunger", "Hathwellcrisping", "Chilli_Axe"),
      // Colorless artifacts
      makeCase("Sol Ring", "Hathwellcrisping", "WillieTanner"),
      makeCase("Mana Crypt", "Hathwellcrisping", "MrTeferi"),
      // Instants
      makeCase("Path to Exile", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Counterspell", "Hathwellcrisping", "JohnPrime"),
      makeCase("Lightning Bolt", "Hathwellcrisping", "WillieTanner"),
      makeCase("Dark Ritual", "Hathwellcrisping", "MrTeferi"),
      makeCase("Beast Within", "Hathwellcrisping", "Chilli_Axe"),
      // Sorceries
      makeCase("Wrath of God", "Hathwellcrisping", "JohnPrime"),
      makeCase("Demonic Tutor", "Hathwellcrisping", "WillieTanner"),
      makeCase("Wheel of Fortune", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Cultivate", "Hathwellcrisping", "MrTeferi"),
      // Enchantments
      makeCase("Smothering Tithe", "Hathwellcrisping", "JohnPrime"),
      makeCase("Rhystic Study", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Sylvan Library", "Hathwellcrisping", "MrTeferi"),
      // Planeswalkers
      makeCase("Jace, the Mind Sculptor", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Liliana of the Veil", "Hathwellcrisping", "JohnPrime"),
      makeCase("Karn Liberated", "Hathwellcrisping", "WillieTanner"),
      makeCase(
        "Chandra, Torch of Defiance",
        "Hathwellcrisping",
        "MrTeferi"
      ),
      // Lands
      makeCase("Command Tower", "Hathwellcrisping", "WillieTanner"),
      makeCase("Ancient Tomb", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Gaea's Cradle", "Hathwellcrisping", "JohnPrime"),
      makeCase("Urborg, Tomb of Yawgmoth", "Hathwellcrisping", "MrTeferi"),
    ];

    const model = trainMpcPreferenceModel(cases, {
      emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
      minCaseCount: 1,
    });

    expect(model).not.toBeNull();
    expect(model!.trainingCaseCount).toBe(cases.length);
    expect(model!.sourceWeights["Hathwellcrisping"]).toBeGreaterThan(0);

    // Verify the model correctly ranks Hathwellcrisping candidates higher
    for (const calibrationCase of cases.slice(0, 5)) {
      const ranked = buildMpcPreferenceScoreMap(
        model!,
        calibrationCase.candidates
      );
      expect(ranked[calibrationCase.expectedIdentifier!]).toBeGreaterThan(
        ranked[calibrationCase.candidates[1].identifier]
      );
    }
  });

  it("measures held-out top1 accuracy", () => {
    const cases = [
      makeCase("Windborn Muse", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Talrand, Sky Summoner", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Thassa, Deep-Dwelling", "Chilli_Axe", "Hathwellcrisping"),
      makeCase("Approach of the Second Sun", "Hathwellcrisping", "Chilli_Axe"),
    ];

    const result = evaluateHeldOutPreferenceModel(cases, {
      emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
      minCaseCount: 1,
    });

    expect(result.total).toBe(4);
    expect(result.top1).toBeGreaterThan(0);
  });

  it("measures held-out accuracy across diverse card types", () => {
    const cases = [
      // Mix of types and colors
      makeCase("Thalia, Guardian of Thraben", "Hathwellcrisping", "JohnPrime"),
      makeCase("Snapcaster Mage", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Sheoldred, the Apocalypse", "Hathwellcrisping", "MrTeferi"),
      makeCase("Dockside Extortionist", "Hathwellcrisping", "WillieTanner"),
      makeCase("Craterhoof Behemoth", "Hathwellcrisping", "JohnPrime"),
      makeCase("Sol Ring", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Lightning Bolt", "Hathwellcrisping", "MrTeferi"),
      makeCase("Wrath of God", "Hathwellcrisping", "WillieTanner"),
      makeCase("Smothering Tithe", "Hathwellcrisping", "JohnPrime"),
      makeCase("Jace, the Mind Sculptor", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Command Tower", "Hathwellcrisping", "MrTeferi"),
      makeCase("Ancient Tomb", "Hathwellcrisping", "WillieTanner"),
    ];

    const result = evaluateHeldOutPreferenceModel(cases, {
      emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
      minCaseCount: 1,
    });

    expect(result.total).toBe(12);
    expect(result.top1).toBeGreaterThanOrEqual(8);
  });

  it("bootstraps source-labelled examples for Hathwellcrisping and Chilli_Axe", () => {
    const cases = [
      makeCase("Windborn Muse", "Hathwellcrisping", "Chilli_Axe"),
      makeCase("Thassa, Deep-Dwelling", "Chilli_Axe", "Hathwellcrisping"),
      makeCase("Proxy Pixie Example", "ProxyPixie", "MrTeferi"),
    ];

    const dataset = buildBootstrappedSourcePreferenceDataset(cases, [
      "Hathwellcrisping",
      "Chilli_Axe",
    ]);

    expect(dataset).toHaveLength(2);
    expect(dataset[0]?.emphasizedSourcesPresent.length).toBeGreaterThan(0);
    expect(dataset[1]?.emphasizedSourcesPresent.length).toBeGreaterThan(0);
  });
});
