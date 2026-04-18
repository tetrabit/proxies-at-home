import type {
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";
import type { MpcPreferenceCase, MpcPreferenceFixture } from "@/types";
import { db } from "@/db";
import recoveredFixture from "../../tests/fixtures/mpc-preference-defaults.v1.json";
import { importMpcCalibrationFixture } from "./mpcCalibrationImport";
import {
  listDefaultMpcCalibrationCases,
  MPC_CALIBRATION_DEFAULT_DATASET_NAME,
} from "./mpcCalibrationStorage";
import type { MpcAutofillCard } from "./mpcAutofillApi";
import {
  electronPreferenceSyncTarget,
  isElectronPreferenceSyncAvailable,
} from "./electronPreferenceSyncTarget";
import {
  fsAccessPreferenceTarget,
  isFsAccessPreferenceSyncAvailable,
} from "./fsAccessPreferenceTarget";
import {
  loadActivePreferenceOverrides,
  serializeCurrentPreferenceFixture,
} from "./mpcPreferenceSync";

export const BOOTSTRAP_PREFERENCE_SOURCES = ["Hathwellcrisping", "Chilli_Axe"];

export interface MpcHarvestedSourceExample {
  cardName: string;
  sourceName: string;
  candidates: Array<{
    identifier: string;
    name: string;
    rawName: string;
    dpi: number;
    tags: string[];
    sourceName: string;
    imageUrl?: string;
  }>;
}

export const BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES = [
  // White creatures
  "Thalia, Guardian of Thraben",
  "Sun Titan",
  "Elesh Norn, Grand Cenobite",
  "Avacyn, Angel of Hope",
  "Mother of Runes",
  "Adeline, Resplendent Cathar",
  // Blue creatures
  "Snapcaster Mage",
  "Consecrated Sphinx",
  "Vendilion Clique",
  "Mulldrifter",
  "Hullbreaker Horror",
  "Thassa, Deep-Dwelling",
  // Black creatures
  "Sheoldred, the Apocalypse",
  "Grave Titan",
  "Massacre Wurm",
  "Rankle, Master of Pranks",
  "Phyrexian Obliterator",
  "Grim Haruspex",
  // Red creatures
  "Dockside Extortionist",
  "Etali, Primal Storm",
  "Inferno Titan",
  "Goblin Rabblemaster",
  "Terror of the Peaks",
  "Neheb, the Eternal",
  // Green creatures
  "Craterhoof Behemoth",
  "Vorinclex, Voice of Hunger",
  "Oracle of Mul Daya",
  "Tireless Tracker",
  "Reclamation Sage",
  "Beast Whisperer",
  // Colorless creatures
  "Wurmcoil Engine",
  "Myr Battlesphere",
  "Platinum Angel",
  "Blightsteel Colossus",
  // White instants
  "Path to Exile",
  "Swords to Plowshares",
  "Teferi's Protection",
  "Generous Gift",
  // Blue instants
  "Counterspell",
  "Force of Will",
  "Cyclonic Rift",
  "Brainstorm",
  "Mystical Tutor",
  // Black instants
  "Dark Ritual",
  "Vampiric Tutor",
  "Deadly Rollick",
  "Malicious Affliction",
  // Red instants
  "Lightning Bolt",
  "Chaos Warp",
  "Deflecting Swat",
  "Red Elemental Blast",
  // Green instants
  "Worldly Tutor",
  "Beast Within",
  "Heroic Intervention",
  "Collected Company",
  // White sorceries
  "Wrath of God",
  "Approach of the Second Sun",
  "Austere Command",
  "Farewell",
  // Blue sorceries
  "Ponder",
  "Preordain",
  "Time Warp",
  "Serum Visions",
  // Black sorceries
  "Demonic Tutor",
  "Toxic Deluge",
  "Damnation",
  "Exsanguinate",
  // Red sorceries
  "Wheel of Fortune",
  "Blasphemous Act",
  "Vandalblast",
  "Jeska's Will",
  // Green sorceries
  "Cultivate",
  "Green Sun's Zenith",
  "Kodama's Reach",
  "Tooth and Nail",
  // Artifacts
  "Sol Ring",
  "Mana Crypt",
  "Arcane Signet",
  "Lightning Greaves",
  "Swiftfoot Boots",
  "Sensei's Divining Top",
  "Chromatic Lantern",
  "Thought Vessel",
  // Enchantments
  "Smothering Tithe",
  "Rhystic Study",
  "Mystic Remora",
  "Phyrexian Arena",
  "Sylvan Library",
  "Blind Obedience",
  // Planeswalkers
  "Jace, the Mind Sculptor",
  "Liliana of the Veil",
  "Teferi, Time Raveler",
  "Karn Liberated",
  "Ugin, the Spirit Dragon",
  "Wrenn and Six",
  "Nissa, Who Shakes the World",
  "Chandra, Torch of Defiance",
  // Lands
  "Command Tower",
  "Reliquary Tower",
  "Ancient Tomb",
  "Strip Mine",
  "Wasteland",
  "Urborg, Tomb of Yawgmoth",
  "Cabal Coffers",
  "Gaea's Cradle",
  "Nykthos, Shrine to Nyx",
  "Boseiju, Who Endures",
];

type RecoveredFixture = {
  cases: Array<{
    name: string;
    expectedIdentifier: string;
    candidates: Array<{
      identifier: string;
      name: string;
      rawName?: string;
      smallThumbnailUrl: string;
      mediumThumbnailUrl: string;
      imageUrl?: string;
      dpi: number;
      tags: string[];
      sourceName: string;
      source: string;
      extension: string;
      size: number;
    }>;
  }>;
};

function buildMpcPreferenceKey(source: MpcPreferenceCase["source"]): string {
  const normalizedName = source.name.trim().toLowerCase();
  const normalizedSet = source.set?.trim().toLowerCase();
  const normalizedCollectorNumber = source.collectorNumber
    ?.trim()
    .toLowerCase();

  if (!normalizedSet && !normalizedCollectorNumber) {
    return normalizedName;
  }

  return [normalizedName, normalizedSet ?? "", normalizedCollectorNumber ?? ""].join(
    "::"
  );
}

export function buildBootstrapPreferenceDefaults(): MpcPreferenceFixture {
  const sourceSet = new Set(BOOTSTRAP_PREFERENCE_SOURCES);
  const filteredCases = (recoveredFixture as RecoveredFixture).cases.filter(
    (calibrationCase) => {
      const expected = calibrationCase.candidates.find(
        (candidate) =>
          candidate.identifier === calibrationCase.expectedIdentifier
      );
      return expected ? sourceSet.has(expected.sourceName) : false;
    }
  );

  return {
    version: 1,
    exportedAt: new Date(0).toISOString(),
    cases: filteredCases.map((calibrationCase) => ({
      source: {
        name: calibrationCase.name,
      },
      candidates: calibrationCase.candidates.map((candidate) => ({
        ...candidate,
        rawName: candidate.rawName ?? candidate.name,
        imageUrl:
          candidate.imageUrl ??
          `/api/cards/images/mpc?id=${candidate.identifier}&size=small`,
      })),
      expectedIdentifier: calibrationCase.expectedIdentifier,
    })),
  };
}

export function mergeMpcPreferenceFixtures(
  defaultFixture: MpcPreferenceFixture,
  userFixture?: MpcPreferenceFixture | null
): MpcPreferenceFixture {
  if (!userFixture) {
    return defaultFixture;
  }

  const mergedCases = new Map<string, MpcPreferenceCase>();

  for (const calibrationCase of defaultFixture.cases) {
    mergedCases.set(buildMpcPreferenceKey(calibrationCase.source), calibrationCase);
  }

  for (const calibrationCase of userFixture.cases) {
    mergedCases.set(buildMpcPreferenceKey(calibrationCase.source), calibrationCase);
  }

  return {
    version: Math.max(defaultFixture.version, userFixture.version),
    exportedAt:
      [defaultFixture.exportedAt, userFixture.exportedAt]
        .filter(Boolean)
        .sort()
        .at(-1) ?? defaultFixture.exportedAt,
    cases: Array.from(mergedCases.values()),
  };
}

export function buildBootstrapPreferenceFixture(
  userFixture?: MpcPreferenceFixture | null
) {
  const mergedFixture = mergeMpcPreferenceFixtures(
    buildBootstrapPreferenceDefaults(),
    userFixture
  );
  const now = Date.now();
  const dataset: MpcCalibrationDatasetRecord = {
    id: "bootstrap-preference-dataset",
    name: MPC_CALIBRATION_DEFAULT_DATASET_NAME,
    description:
      "Bootstrapped preference data emphasizing Hathwellcrisping and Chilli_Axe",
    targetCaseCount: mergedFixture.cases.length,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const cases: MpcCalibrationCaseRecord[] = mergedFixture.cases.map(
    (calibrationCase, index) => ({
      id: `bootstrap-case-${index + 1}`,
      datasetId: dataset.id,
      createdAt: now,
      updatedAt: now,
      source: calibrationCase.source,
      candidates: calibrationCase.candidates.map((candidate) => ({
        ...candidate,
        rawName: candidate.rawName ?? candidate.name,
        imageUrl:
          candidate.imageUrl ??
          `/api/cards/images/mpc?id=${candidate.identifier}&size=small`,
      })),
      expectedIdentifier: calibrationCase.expectedIdentifier,
      notes: calibrationCase.notes,
      comparisonHints: calibrationCase.comparisonHints,
    })
  );

  return {
    version: 1,
    exportedAt: new Date(now).toISOString(),
    dataset,
    cases,
    assets: [],
    runs: [],
  };
}

export async function hydrateMpcPreferences(
  userFixture?: MpcPreferenceFixture | null
): Promise<void> {
  if (!db.mpcCalibrationDatasets || !db.mpcCalibrationCases) {
    return;
  }

  const existingCases = await listDefaultMpcCalibrationCases();
  if (existingCases.length > 0) {
    if (userFixture === undefined) {
      const { target, fixture: activeFixture } = await loadActivePreferenceOverrides();
      if (target && !activeFixture) {
        await target.write(await serializeCurrentPreferenceFixture());
      }
    }

    return;
  }

  const runtimeUserFixture = userFixture === undefined
    ? (await loadActivePreferenceOverrides()).fixture
    : userFixture;

  await importMpcCalibrationFixture(
    buildBootstrapPreferenceFixture(runtimeUserFixture)
  );
}

export async function ensureBootstrapPreferenceDataset(): Promise<void> {
  await hydrateMpcPreferences();
}

export async function harvestSourcePreferenceCandidates(
  seedCardNames: string[],
  search: (name: string) => Promise<MpcAutofillCard[]>,
  targetSources: string[] = BOOTSTRAP_PREFERENCE_SOURCES
): Promise<MpcHarvestedSourceExample[]> {
  const targetSet = new Set(targetSources);
  const harvested: MpcHarvestedSourceExample[] = [];

  for (const seedCardName of seedCardNames) {
    const candidates = await search(seedCardName);
    if (candidates.length === 0) continue;

    for (const sourceName of targetSources) {
      const matching = candidates.filter(
        (candidate) =>
          targetSet.has(candidate.sourceName) &&
          candidate.sourceName === sourceName
      );
      if (matching.length === 0) continue;

      harvested.push({
        cardName: seedCardName,
        sourceName,
        candidates: matching.map((candidate) => ({
          identifier: candidate.identifier,
          name: candidate.name,
          rawName: candidate.rawName ?? candidate.name,
          dpi: candidate.dpi,
          tags: candidate.tags,
          sourceName: candidate.sourceName,
          imageUrl: candidate.smallThumbnailUrl || candidate.mediumThumbnailUrl,
        })),
      });
    }
  }

  return harvested;
}
