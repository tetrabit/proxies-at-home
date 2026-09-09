import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMpcPreferenceContextBuilderKeyInput,
  getSharedMpcPreferenceContext,
} from "./mpcPreferenceContextBuilder";
import { resetMpcPreferenceContextCacheForTests } from "./mpcPreferenceContext";

const { mockTrainMpcPreferenceModel, mockBuildMpcSourceVisualProfiles } = vi.hoisted(
  () => ({
    mockTrainMpcPreferenceModel: vi.fn(),
    mockBuildMpcSourceVisualProfiles: vi.fn(),
  })
);

vi.mock("./mpcPreferenceModel", () => ({
  trainMpcPreferenceModel: mockTrainMpcPreferenceModel,
}));

vi.mock("./mpcVisualPreference", () => ({
  buildMpcSourceVisualProfiles: mockBuildMpcSourceVisualProfiles,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const calibrationCases = [
  {
    id: "ephemeral-case-id",
    datasetId: "ephemeral-dataset-id",
    createdAt: 1,
    updatedAt: 2,
    source: { name: "Lightning Bolt", set: "lea", collectorNumber: "161" },
    candidates: [
      {
        identifier: "provider-card-1",
        name: "Lightning Bolt",
        rawName: "Lightning Bolt",
        dpi: 800,
        tags: ["old-border"],
        sourceName: "Hathwellcrisping",
        smallThumbnailUrl: "https://example.invalid/small",
        mediumThumbnailUrl: "https://example.invalid/medium",
        source: "provider",
        extension: "jpg",
        size: 42,
      },
    ],
    expectedIdentifier: "provider-card-1",
  },
] as never[];

function makeInput(overrides = {}) {
  return {
    dataset: {
      calibrationCases,
      version: 1,
      content: { datasetName: "MPC Calibration Harness" },
    },
    source: {
      version: "seed-list-v1",
      content: {
        seedCardNames: ["Lightning Bolt"],
        targetSources: ["Hathwellcrisping"],
      },
      loadExamples: vi.fn().mockResolvedValue([]),
    },
    provider: {
      version: "mpc-autofill-v1",
      content: { cardType: "CARD", exactName: true },
    },
    algorithm: {
      version: "preference-model-v1",
      content: {
        emphasizedSources: ["Hathwellcrisping"],
        visualProfileAlgorithm: "descriptor-v1",
      },
      trainingOptions: { emphasizedSources: ["Hathwellcrisping"] },
    },
    ...overrides,
  };
}

describe("mpcPreferenceContextBuilder", () => {
  beforeEach(() => {
    resetMpcPreferenceContextCacheForTests();
    vi.clearAllMocks();
    mockTrainMpcPreferenceModel.mockReturnValue({ sourceWeights: {} });
    mockBuildMpcSourceVisualProfiles.mockResolvedValue({});
  });

  it("builds the cache key from complete supplied dataset, source, provider, and algorithm inputs", () => {
    const input = makeInput();

    const keyInput = createMpcPreferenceContextBuilderKeyInput(input);

    expect(keyInput).toMatchObject({
      datasetVersion: 1,
      sourceVersion: "seed-list-v1",
      providerVersion: "mpc-autofill-v1",
      algorithmVersion: "preference-model-v1",
    });
    expect(keyInput.datasetContent).toContain("Lightning Bolt");
    expect(keyInput.datasetContent).toContain("provider-card-1");
    expect(keyInput.datasetContent).not.toContain("ephemeral-case-id");
    expect(keyInput.datasetContent).not.toContain("ephemeral-dataset-id");
    expect(keyInput.sourceContent).toContain("seedCardNames");
    expect(keyInput.providerContent).toContain("exactName");
    expect(keyInput.algorithmContent).toContain("visualProfileAlgorithm");
  });

  it("coalesces equivalent builds and only aborts the closing subscriber", async () => {
    const examples = deferred<[]>();
    const input = makeInput({
      source: {
        version: "seed-list-v1",
        content: { seedCardNames: ["Lightning Bolt"] },
        loadExamples: vi.fn(() => examples.promise),
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getSharedMpcPreferenceContext(input, firstController.signal);
    const second = getSharedMpcPreferenceContext(input, secondController.signal);
    firstController.abort(new DOMException("modal closed", "AbortError"));
    examples.resolve([]);

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ calibrationCases });
    expect(input.source.loadExamples).toHaveBeenCalledTimes(1);
    expect(mockBuildMpcSourceVisualProfiles).toHaveBeenCalledWith([]);
  });
});
