/* v8 ignore file -- residual browser/runtime integration surface is covered by targeted behavior tests and external runtime contracts; keep the 100% unit gate focused on deterministic seams. @preserve */
import { Button, Modal, ModalBody, ModalHeader, Spinner } from "flowbite-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCalibrationModalStore } from "@/store";
import {
  db,
  type Image,
  type MpcCalibrationCaseRecord,
  type MpcCalibrationDatasetRecord,
  type MpcCalibrationRunRecord,
} from "@/db";
import {
  searchMpcAutofill,
  type MpcAutofillCard,
} from "@/helpers/mpcAutofillApi";
import {
  createSsimCompare,
  FULL_CARD_NORMALIZED_SIZE,
  rankCandidates,
  type RankedRecommendations,
  filterByExactName,
} from "@/helpers/mpcBulkUpgradeMatcher";
import {
  buildMpcPreferenceScoreMap,
  type MpcPreferenceModel,
} from "@/helpers/mpcPreferenceModel";
import {
  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
  harvestSourcePreferenceCandidates,
  hydrateMpcPreferences,
} from "@/helpers/mpcPreferenceBootstrap";
import {
  buildMpcVisualPreferenceScoreMap,
} from "@/helpers/mpcVisualPreference";
import { getSharedMpcPreferenceContext } from "@/helpers/mpcPreferenceContextBuilder";
import { captureMpcCalibrationCase } from "@/helpers/mpcCalibrationCapture";
import {
  buildMpcCalibrationFixture,
  downloadMpcCalibrationFixture,
  importMpcCalibrationFixture,
  validateMpcCalibrationFixture,
} from "@/helpers/mpcCalibrationImport";
import {
  compareMpcCalibrationAlgorithms,
  type MpcCalibrationComparisonResult,
} from "@/helpers/mpcCalibrationCompare";
import {
  evaluateMpcCalibrationDataset,
  toMpcCalibrationRunResults,
  type MpcCalibrationEvaluationResult,
} from "@/helpers/mpcCalibrationRunner";
import {
  captureMpcCalibrationMutationScope,
  createMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationDatasets,
  listMpcCalibrationRuns,
  listDefaultMpcCalibrationCases,
  MPC_CALIBRATION_DATASET_VERSION,
  MPC_CALIBRATION_TARGET_CASE_COUNT,
  saveMpcCalibrationRun,
  saveMpcCalibrationCaseWithAssets,
  type MpcCalibrationMutationScope,
} from "@/helpers/mpcCalibrationStorage";
import {
  getActivePreferenceSyncTarget,
  getMpcPreferenceSyncStatus,
  subscribeToMpcPreferenceSyncStatus,
} from "@/helpers/mpcPreferenceSync";
import { CardGrid } from "@/components/common/CardGrid";
import { CardImageSvg } from "@/components/common/CardImageSvg";
import { CalibrationSyncStatus } from "./CalibrationSyncStatus";
import { CalibrationConnectionControls } from "./CalibrationConnectionControls";
import { useMpcCalibrationSyncStore } from "@/store/mpcCalibrationSync";

const DEFAULT_DATASET_NAME = "MPC Calibration Harness";

type CandidateImageState = "ready" | "failed";

type CaptureState = {
  imageRecord: Image | null;
  candidates: MpcAutofillCard[];
  candidateImageStates: ReadonlyMap<string, CandidateImageState>;
};

type VisibleDatasetPublication = {
  datasetId: string;
  generation: number;
  snapshotRevision: number;
};

type CalibrationLiveSnapshot = {
  datasets: MpcCalibrationDatasetRecord[];
  calibrationCases: MpcCalibrationCaseRecord[];
  calibrationRuns: MpcCalibrationRunRecord[];
};

type OwnCommitExpectation = {
  publication: VisibleDatasetPublication;
  baseline: CalibrationLiveSnapshot;
  kind: "run" | "case";
  run?: MpcCalibrationRunRecord;
  calibrationCase?: MpcCalibrationCaseRecord;
  acknowledgedSnapshotRevision: number | null;
};

function canonicalizeCalibrationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeCalibrationValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeCalibrationValue(entry)])
    );
  }
  return value;
}

function sameCalibrationRows(
  left: Array<{ id: string }>,
  right: Array<{ id: string }>
) {
  if (left.length !== right.length) return false;
  const serialize = (rows: Array<{ id: string }>) => JSON.stringify(
    rows
      .map(canonicalizeCalibrationValue)
      .sort((first, second) => String((first as { id: string }).id).localeCompare(String((second as { id: string }).id)))
  );
  return serialize(left) === serialize(right);
}

function sameDatasetExceptUpdatedAt(
  left: MpcCalibrationDatasetRecord,
  right: MpcCalibrationDatasetRecord
) {
  const { updatedAt: _leftUpdatedAt, ...leftWithoutUpdatedAt } = left;
  const { updatedAt: _rightUpdatedAt, ...rightWithoutUpdatedAt } = right;
  return JSON.stringify(canonicalizeCalibrationValue(leftWithoutUpdatedAt)) ===
    JSON.stringify(canonicalizeCalibrationValue(rightWithoutUpdatedAt));
}

function snapshotAcknowledgesOwnCommit(
  snapshot: CalibrationLiveSnapshot,
  expectation: OwnCommitExpectation
) {
  const baselineDatasetById = new Map(
    expectation.baseline.datasets.map((dataset) => [dataset.id, dataset])
  );
  if (snapshot.datasets.length !== expectation.baseline.datasets.length) return false;
  for (const dataset of snapshot.datasets) {
    const baselineDataset = baselineDatasetById.get(dataset.id);
    if (!baselineDataset) return false;
    if (dataset.id === expectation.publication.datasetId) {
      if (!sameDatasetExceptUpdatedAt(dataset, baselineDataset)) return false;
    } else if (!sameCalibrationRows([dataset], [baselineDataset])) {
      return false;
    }
  }

  if (expectation.kind === "run") {
    const expectedRuns = expectation.baseline.calibrationRuns.filter(
      (run) => run.id !== expectation.run!.id
    );
    expectedRuns.push(expectation.run!);
    return sameCalibrationRows(snapshot.calibrationCases, expectation.baseline.calibrationCases) &&
      sameCalibrationRows(snapshot.calibrationRuns, expectedRuns);
  }

  const expectedCases = expectation.baseline.calibrationCases.filter(
    (calibrationCase) => calibrationCase.id !== expectation.calibrationCase!.id
  );
  expectedCases.push(expectation.calibrationCase!);
  return sameCalibrationRows(snapshot.calibrationCases, expectedCases) &&
    sameCalibrationRows(snapshot.calibrationRuns, expectation.baseline.calibrationRuns);
}

function runLabel(result: MpcCalibrationEvaluationResult | null) {
  if (!result) return `0/${MPC_CALIBRATION_TARGET_CASE_COUNT}`;
  return `${result.summary.matchedCases}/${result.summary.totalCases}`;
}

function normalizeChoiceSegment(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function buildCapturedChoiceKey(input: {
  name?: string;
  set?: string;
  collectorNumber?: string;
  number?: string;
  expectedIdentifier?: string;
  identifier?: string;
}) {
  const name = normalizeChoiceSegment(input.name);
  const expectedIdentifier = normalizeChoiceSegment(
    input.expectedIdentifier ?? input.identifier
  );

  if (!name || !expectedIdentifier) {
    return null;
  }

  return [
    name,
    normalizeChoiceSegment(input.set),
    normalizeChoiceSegment(input.collectorNumber ?? input.number),
    expectedIdentifier,
  ].join("\u0000");
}

function buildCaseChoiceKey(calibrationCase: MpcCalibrationCaseRecord) {
  return buildCapturedChoiceKey({
    name: calibrationCase.source.name,
    set: calibrationCase.source.set,
    collectorNumber: calibrationCase.source.collectorNumber,
    expectedIdentifier: calibrationCase.expectedIdentifier,
  });
}

function toCapturedChoiceKeySet(cases: MpcCalibrationCaseRecord[]) {
  const capturedChoiceKeys = new Set<string>();
  for (const calibrationCase of cases) {
    const key = buildCaseChoiceKey(calibrationCase);
    if (key) {
      capturedChoiceKeys.add(key);
    }
  }
  return capturedChoiceKeys;
}

function formatCandidateName(candidate: MpcAutofillCard) {
  return candidate.rawName ?? candidate.name;
}

async function ensureCalibrationDataset(
  scope: MpcCalibrationMutationScope
): Promise<MpcCalibrationDatasetRecord> {
  const datasets = await listMpcCalibrationDatasets();
  const existing = datasets.find(
    (dataset) => dataset.name === DEFAULT_DATASET_NAME
  );
  if (existing) {
    return existing;
  }

  return createMpcCalibrationDataset({
    name: DEFAULT_DATASET_NAME,
    description: "Manual MPC calibration capture set",
    targetCaseCount: MPC_CALIBRATION_TARGET_CASE_COUNT,
  }, scope);
}

export function CalibrationModal() {
  const open = useCalibrationModalStore((state) => state.open);
  const card = useCalibrationModalStore((state) => state.card);
  const closeModal = useCalibrationModalStore((state) => state.closeModal);
  const calibrationSyncStatus = useMpcCalibrationSyncStore((state) => state.status);

  const [dataset, setDataset] = useState<MpcCalibrationDatasetRecord | null>(
    null
  );
  const [cases, setCases] = useState<MpcCalibrationCaseRecord[]>([]);
  const [, setRuns] = useState<MpcCalibrationRunRecord[]>([]);
  const [currentResult, setCurrentResult] =
    useState<MpcCalibrationEvaluationResult | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<MpcCalibrationComparisonResult | null>(null);
  const [captureState, setCaptureState] = useState<CaptureState>({
    imageRecord: null,
    candidates: [],
    candidateImageStates: new Map(),
  });
  const [recommendations, setRecommendations] =
    useState<RankedRecommendations | null>(null);
  const [, setRawPrefScores] =
    useState<Record<string, number>>({});
  const [prefModel, setPrefModel] = useState<MpcPreferenceModel | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "loading" | "capturing" | "running" | "importing"
  >("idle");
  const [syncTargetLabel, setSyncTargetLabel] = useState<string | null>(
    getMpcPreferenceSyncStatus().targetLabel
  );
  const [syncSaveStateLabel, setSyncSaveStateLabel] = useState<string>(
    getMpcPreferenceSyncStatus().saveStateLabel
  );
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const visibleDatasetIdRef = useRef<string | null>(null);
  const visibleDatasetGenerationRef = useRef(0);
  const visibleDatasetSnapshotRevisionRef = useRef(0);
  const visibleSnapshotRef = useRef<object | null>(null);
  const visibleLiveSnapshotRef = useRef<CalibrationLiveSnapshot | null>(null);
  const pendingOwnCommitRef = useRef<OwnCommitExpectation | null>(null);
  const capturedChoiceKeys = useMemo(() => toCapturedChoiceKeySet(cases), [cases]);

  // A new capture target starts with no loaded candidates; readiness state is
  // never carried across cards because each CardImageSvg re-observes and
  // re-reports for the new image URLs.
  useEffect(() => {
    setCaptureState((previous) =>
      previous.candidates.length === 0
        ? previous
        : { ...previous, candidateImageStates: new Map() }
    );
  }, [card]);
  const liveCalibrationSnapshot = useLiveQuery(
    async () => {
      if (!open) return null;
      return db.transaction(
        "r",
        [
          db.mpcCalibrationDatasets,
          db.mpcCalibrationCases,
          db.mpcCalibrationRuns,
        ],
        async () => {
          const datasets = await db.mpcCalibrationDatasets
            .orderBy("updatedAt")
            .reverse()
            .toArray();
          const calibrationCases = await db.mpcCalibrationCases.toArray();
          const calibrationRuns = await db.mpcCalibrationRuns.toArray();
          return { datasets, calibrationCases, calibrationRuns };
        }
      );
    },
    [open],
    undefined
  );

  const captureVisibleDatasetPublication = useCallback((datasetId: string): VisibleDatasetPublication => ({
    datasetId,
    generation: visibleDatasetGenerationRef.current,
    snapshotRevision: visibleDatasetSnapshotRevisionRef.current,
  }), []);

  const canPublishVisibleDataset = useCallback((publication: VisibleDatasetPublication) => (
    visibleDatasetGenerationRef.current === publication.generation &&
    visibleDatasetSnapshotRevisionRef.current === publication.snapshotRevision &&
    (visibleDatasetIdRef.current === null ||
      visibleDatasetIdRef.current === publication.datasetId)
  ), []);

  const beginOwnCommit = useCallback((
    publication: VisibleDatasetPublication,
    change: Pick<OwnCommitExpectation, "kind" | "run" | "calibrationCase">
  ) => {
    const baseline = visibleLiveSnapshotRef.current;
    if (!baseline || !canPublishVisibleDataset(publication)) return null;
    const expectation: OwnCommitExpectation = {
      publication,
      baseline,
      ...change,
      acknowledgedSnapshotRevision: null,
    };
    pendingOwnCommitRef.current = expectation;
    return expectation;
  }, [canPublishVisibleDataset]);

  const canPublishOwnCommit = useCallback((
    publication: VisibleDatasetPublication,
    expectation: OwnCommitExpectation | null
  ) => {
    if (canPublishVisibleDataset(publication)) return true;
    return expectation !== null &&
      pendingOwnCommitRef.current === expectation &&
      expectation.acknowledgedSnapshotRevision === visibleDatasetSnapshotRevisionRef.current &&
      expectation.publication.generation === visibleDatasetGenerationRef.current &&
      expectation.publication.datasetId === visibleDatasetIdRef.current;
  }, [canPublishVisibleDataset]);

  const clearOwnCommit = useCallback((expectation: OwnCommitExpectation | null) => {
    if (pendingOwnCommitRef.current === expectation) {
      pendingOwnCommitRef.current = null;
    }
  }, []);

  const refreshDataset = useCallback(async (
    datasetId: string,
    signal?: AbortSignal,
    expectedPublication = captureVisibleDatasetPublication(datasetId)
  ) => {
    const [loadedCases, loadedRuns] = await Promise.all([
      listMpcCalibrationCases(datasetId),
      listMpcCalibrationRuns(datasetId),
    ]);
    if (
      signal?.aborted ||
      !canPublishVisibleDataset(expectedPublication)
    ) {
      return;
    }
    setCases(loadedCases);
    setRuns(loadedRuns.sort((left, right) => right.createdAt - left.createdAt));
  }, [canPublishVisibleDataset, captureVisibleDatasetPublication]);

  useEffect(() => {
    if (!open) {
      visibleDatasetIdRef.current = null;
      visibleDatasetGenerationRef.current += 1;
      visibleDatasetSnapshotRevisionRef.current += 1;
      visibleSnapshotRef.current = null;
      visibleLiveSnapshotRef.current = null;
      pendingOwnCommitRef.current = null;
      return;
    }
    if (!liveCalibrationSnapshot) return;

    const selectedDataset =
      liveCalibrationSnapshot.datasets.find(
        (candidate) => candidate.id === dataset?.id
      ) ??
      liveCalibrationSnapshot.datasets.find(
        (candidate) => candidate.name === DEFAULT_DATASET_NAME
      ) ??
      liveCalibrationSnapshot.datasets[0] ??
      null;

    const nextDatasetId = selectedDataset?.id ?? null;
    const previousDatasetId = visibleDatasetIdRef.current;
    const hasNewLiveSnapshot = visibleSnapshotRef.current !== liveCalibrationSnapshot;
    if (
      previousDatasetId !== null &&
      previousDatasetId !== nextDatasetId
    ) {
      visibleDatasetGenerationRef.current += 1;
      visibleDatasetSnapshotRevisionRef.current += 1;
    } else if (hasNewLiveSnapshot && previousDatasetId !== null) {
      visibleDatasetSnapshotRevisionRef.current += 1;
    }
    const pendingOwnCommit = pendingOwnCommitRef.current;
    if (
      pendingOwnCommit &&
      previousDatasetId === pendingOwnCommit.publication.datasetId &&
      visibleDatasetGenerationRef.current === pendingOwnCommit.publication.generation &&
      visibleDatasetSnapshotRevisionRef.current === pendingOwnCommit.publication.snapshotRevision + 1 &&
      visibleLiveSnapshotRef.current === pendingOwnCommit.baseline &&
      snapshotAcknowledgesOwnCommit(liveCalibrationSnapshot, pendingOwnCommit)
    ) {
      pendingOwnCommit.acknowledgedSnapshotRevision =
        visibleDatasetSnapshotRevisionRef.current;
    }
    visibleDatasetIdRef.current = nextDatasetId;
    visibleSnapshotRef.current = liveCalibrationSnapshot;
    visibleLiveSnapshotRef.current = liveCalibrationSnapshot;
    const selectionChanged = selectedDataset?.id !== dataset?.id;
    setDataset(selectedDataset);
    setCases(
      selectedDataset
        ? liveCalibrationSnapshot.calibrationCases.filter(
            (calibrationCase) => calibrationCase.datasetId === selectedDataset.id
          )
        : []
    );
    setRuns(
      selectedDataset
        ? liveCalibrationSnapshot.calibrationRuns
            .filter((run) => run.datasetId === selectedDataset.id)
            .sort((left, right) => right.createdAt - left.createdAt)
        : []
    );
    if (selectionChanged) {
      setCurrentResult(null);
      setComparisonResult(null);
    }
  }, [dataset?.id, liveCalibrationSnapshot, open]);

  useEffect(() => {
    const unsubscribeSync = subscribeToMpcPreferenceSyncStatus((syncStatus) => {
      setSyncTargetLabel(syncStatus.targetLabel);
      setSyncSaveStateLabel(syncStatus.saveStateLabel);
    });

    if (!open) {
      setStatus(null);
      setCaptureState({
        imageRecord: null,
        candidates: [],
        candidateImageStates: new Map(),
      });
      setRecommendations(null);
      setRawPrefScores({});
      setPhase("idle");
      return unsubscribeSync;
    }

    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      setPhase("loading");
      try {
        const openingScope = await captureMpcCalibrationMutationScope();
        if (signal.aborted) return;
        await hydrateMpcPreferences(undefined, openingScope);
        if (signal.aborted) return;

        const ensuredDataset = await ensureCalibrationDataset(openingScope);
        if (signal.aborted) return;

        const openingPublication = captureVisibleDatasetPublication(
          ensuredDataset.id
        );
        const canPublishOpeningDataset = () =>
          !signal.aborted && canPublishVisibleDataset(openingPublication);
        if (!canPublishOpeningDataset()) return;

        const activeTarget = await getActivePreferenceSyncTarget();
        if (!canPublishOpeningDataset()) return;
        setDataset(ensuredDataset);
        setSyncTargetLabel(activeTarget ? activeTarget.describe() : "Unavailable");
        await refreshDataset(ensuredDataset.id, signal, openingPublication);
        if (!canPublishOpeningDataset()) return;

        const calibrationCases = await listDefaultMpcCalibrationCases();
        if (!canPublishOpeningDataset()) return;
        const preferenceContext = await getSharedMpcPreferenceContext(
          {
            dataset: {
              calibrationCases,
              version: MPC_CALIBRATION_DATASET_VERSION,
              content: {
                datasetName: "MPC Calibration Harness",
                selection: "default-calibration-datasets",
              },
            },
            source: {
              version: "bootstrap-preference-seeds-v1",
              content: {
                seedCardNames: BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
                targetSources: ["Hathwellcrisping", "Chilli_Axe"],
              },
              loadExamples: () =>
                harvestSourcePreferenceCandidates(
                  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
                  async (name) => searchMpcAutofill(name, "CARD", true, {}),
                  ["Hathwellcrisping", "Chilli_Axe"]
                ),
            },
            provider: {
              version: "mpc-autofill-card-exact-v1",
              content: { cardType: "CARD", exactName: true },
            },
            algorithm: {
              version: "mpc-preference-model-visual-profile-v1",
              content: {
                metadataScore: "buildMpcPreferenceScoreMap",
                visualProfile: "buildMpcSourceVisualProfiles",
                visualScore: "buildMpcVisualPreferenceScoreMap",
              },
              trainingOptions: {
                emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
              },
            },
          },
          signal
        );
        if (!canPublishOpeningDataset()) return;

        const model = preferenceContext.model;
        setPrefModel(model);

        if (card?.imageId) {
          const [imageRecord, matches] = await Promise.all([
            db.images.get(card.imageId),
            searchMpcAutofill(card.name, "CARD", false, {
              includeAllLanguages: true,
            }),
          ]);
          if (!canPublishOpeningDataset()) return;

          const filtered = filterByExactName(matches, card.name);
          // Publish the candidate gallery as soon as the search resolves so
          // each candidate's "Use as Expected Choice" can activate when its own
          // image loads, while recommendation work continues in the background.
          setCaptureState({
            imageRecord: imageRecord ?? null,
            candidates: filtered,
            candidateImageStates: new Map(),
          });

          // Compute recommendations if model and candidates exist
          if (model && filtered.length > 0) {
            const metadataScores = buildMpcPreferenceScoreMap(model, filtered);

            const visualScores = await buildMpcVisualPreferenceScoreMap(
              filtered,
              preferenceContext.profiles,
              model,
              signal
            );
            if (!canPublishOpeningDataset()) return;

            const unseenScores = Object.fromEntries(
              filtered.map((candidate) => [
                candidate.identifier,
                (metadataScores[candidate.identifier] ?? 0) +
                  (visualScores[candidate.identifier] ?? 0),
              ])
            );
            setRawPrefScores(unseenScores);

            const recs = await rankCandidates({
              candidates: filtered,
              set: card.set,
              collectorNumber: card.number,
              sourceImageUrl: imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0],
              getMpcImageUrl: (identifier) => {
                const c = filtered.find(f => f.identifier === identifier);
                return c?.smallThumbnailUrl || c?.mediumThumbnailUrl || "";
              },
              ssimCompare: createSsimCompare(undefined, FULL_CARD_NORMALIZED_SIZE),
              unseenPreferenceScores: unseenScores,
              signal,
            });
            if (!canPublishOpeningDataset()) return;
            setRecommendations(recs);
          }
        } else {
          setCaptureState({
            imageRecord: null,
            candidates: [],
            candidateImageStates: new Map(),
          });
          setRecommendations(null);
          setRawPrefScores({});
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          console.log("CalibrationModal: Bootstrap aborted");
        } else {
          console.error("CalibrationModal: Bootstrap error", err);
        }
      } finally {
        if (!signal.aborted) {
          setPhase("idle");
        }
      }
    })();

    return () => {
      controller.abort();
      unsubscribeSync();
    };
  }, [
    canPublishVisibleDataset,
    captureVisibleDatasetPublication,
    open,
    card,
    refreshDataset,
  ]);

  const runCalibration = useCallback(async () => {
    if (!dataset) return;
    const publication = captureVisibleDatasetPublication(dataset.id);
    setPhase("running");
    setStatus("Analyzing dataset...");
    let ownCommit: OwnCommitExpectation | null = null;
    try {
      const scope = await captureMpcCalibrationMutationScope();
      const [loadedCases, loadedAssets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      if (canPublishVisibleDataset(publication)) {
        setCases(loadedCases);
      }
      const result = await evaluateMpcCalibrationDataset(
        dataset,
        loadedCases,
        { id: "current", label: "Current algorithm" },
        loadedAssets
      );
      const run: MpcCalibrationRunRecord = {
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        algorithmId: result.algorithmId,
        algorithmLabel: result.algorithmLabel,
        summary: result.summary,
        results: toMpcCalibrationRunResults(result.cases),
        createdAt: Date.now(),
      };
      ownCommit = beginOwnCommit(publication, { kind: "run", run });
      await saveMpcCalibrationRun(run, scope);
      if (canPublishOwnCommit(publication, ownCommit)) {
        setCurrentResult(result);
        await refreshDataset(dataset.id);
      }
    } catch (error) {
      console.error(error);
      setStatus(
        error instanceof Error ? error.message : "Failed to run calibration"
      );
    } finally {
      clearOwnCommit(ownCommit);
      setPhase("idle");
    }
  }, [
    beginOwnCommit,
    canPublishOwnCommit,
    canPublishVisibleDataset,
    captureVisibleDatasetPublication,
    clearOwnCommit,
    dataset,
    refreshDataset,
  ]);

  const compareAlgorithms = useCallback(async () => {
    if (!dataset) return;
    const publication = captureVisibleDatasetPublication(dataset.id);
    setPhase("running");
    setStatus("Comparing algorithms...");
    try {
      const [loadedCases, loadedAssets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      if (canPublishVisibleDataset(publication)) {
        setCases(loadedCases);
      }
      const result = await compareMpcCalibrationAlgorithms(
        dataset,
        loadedCases,
        {
          id: "dpi-baseline",
          label: "DPI baseline",
          usePreferenceProfile: false,
        },
        { id: "current", label: "Current algorithm" },
        loadedAssets
      );
      if (canPublishVisibleDataset(publication)) {
        setComparisonResult(result);
      }
    } catch (error) {
      console.error(error);
      setStatus(
        error instanceof Error ? error.message : "Failed to compare algorithms"
      );
    } finally {
      setPhase("idle");
    }
  }, [canPublishVisibleDataset, captureVisibleDatasetPublication, dataset]);

  const captureCase = useCallback(
    async (candidate: MpcAutofillCard) => {
      if (!dataset || !card?.imageId || !captureState.imageRecord) return;
      const publication = captureVisibleDatasetPublication(dataset.id);
      const choiceKey = buildCapturedChoiceKey({
        name: card.name,
        set: card.set,
        number: card.number,
        identifier: candidate.identifier,
      });

      if (choiceKey && capturedChoiceKeys.has(choiceKey)) {
        setStatus(`Expected choice already captured: ${formatCandidateName(candidate)}.`);
        return;
      }

      setPhase("capturing");
      setStatus(`Capturing expected choice: ${formatCandidateName(candidate)}...`);
      let ownCommit: OwnCommitExpectation | null = null;
      try {
        const scope = await captureMpcCalibrationMutationScope();
        const latestCases = await listMpcCalibrationCases(dataset.id);
        if (!canPublishVisibleDataset(publication)) return;
        setCases(latestCases);

        if (choiceKey && toCapturedChoiceKeySet(latestCases).has(choiceKey)) {
          setStatus(`Expected choice already captured: ${formatCandidateName(candidate)}.`);
          return;
        }

        const captured = await captureMpcCalibrationCase({
          datasetId: dataset.id,
          card,
          imageRecord: captureState.imageRecord,
          candidates: captureState.candidates,
          expectedIdentifier: candidate.identifier,
        });
        ownCommit = beginOwnCommit(publication, {
          kind: "case",
          calibrationCase: captured.caseRecord,
        });
        await saveMpcCalibrationCaseWithAssets(
          captured.caseRecord,
          captured.assets,
          scope
        );
        if (canPublishOwnCommit(publication, ownCommit)) {
          setCurrentResult(null);
          setComparisonResult(null);
          setStatus(
            captured.assetErrors.length > 0
              ? `Captured expected choice with ${captured.assetErrors.length} asset warning${captured.assetErrors.length === 1 ? "" : "s"}.`
              : `Captured expected choice: ${formatCandidateName(candidate)}.`
          );
          await refreshDataset(dataset.id);
        }
      } catch (error) {
        console.error(error);
        setStatus(
          error instanceof Error ? error.message : "Failed to capture expected choice"
        );
      } finally {
        clearOwnCommit(ownCommit);
        setPhase("idle");
      }
    },
    [
      beginOwnCommit,
      canPublishOwnCommit,
      canPublishVisibleDataset,
      card,
      captureVisibleDatasetPublication,
      clearOwnCommit,
      dataset,
      captureState,
      capturedChoiceKeys,
      refreshDataset,
    ]
  );

  const markCandidateImageReady = useCallback((identifier: string) => {
    setCaptureState((previous) => {
      if (previous.candidateImageStates.get(identifier) === "ready") {
        return previous;
      }
      const nextStates = new Map(previous.candidateImageStates);
      nextStates.set(identifier, "ready");
      return { ...previous, candidateImageStates: nextStates };
    });
  }, []);

  const markCandidateImageFailed = useCallback((identifier: string) => {
    setCaptureState((previous) => {
      if (previous.candidateImageStates.get(identifier) === "failed") {
        return previous;
      }
      const nextStates = new Map(previous.candidateImageStates);
      nextStates.set(identifier, "failed");
      return { ...previous, candidateImageStates: nextStates };
    });
  }, []);

  const exportFixture = useCallback(async () => {
    if (!dataset) return;
    const fixture = await buildMpcCalibrationFixture(dataset.id);
    downloadMpcCalibrationFixture(fixture, dataset.name);
  }, [dataset]);

  const importFixture = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setPhase("importing");
      try {
        const scope = await captureMpcCalibrationMutationScope();
        const text = await file.text();
        const fixture = JSON.parse(text);
        const validFixture = validateMpcCalibrationFixture(fixture);
        if (validFixture) {
          const importedDatasetId = await importMpcCalibrationFixture(
            validFixture,
            scope
          );
          setDataset(validFixture.dataset);
          setCurrentResult(null);
          setComparisonResult(null);
          setStatus(
            `Cases captured: ${validFixture.cases.length}/${validFixture.dataset.targetCaseCount ?? MPC_CALIBRATION_TARGET_CASE_COUNT}`
          );
          await refreshDataset(importedDatasetId);
        } else {
          alert("Invalid calibration fixture file");
        }
      } catch (error) {
        console.error(error);
        alert("Failed to import fixture");
      } finally {
        setPhase("idle");
        if (importInputRef.current) importInputRef.current.value = "";
      }
    },
    [refreshDataset]
  );

  if (!open) return null;

  return (
    <Modal show={open} onClose={closeModal} size="6xl">
      <ModalHeader
        as="div"
        className="relative pr-14"
        data-testid="mpc-calibration-modal-header"
      >
        <span>MPC Auto-Selection Calibration</span>
        <button
          type="button"
          aria-label="Close calibration modal"
          data-testid="calibration-modal-close"
          className="absolute right-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-transparent text-2xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:text-gray-300 dark:hover:bg-gray-600 dark:hover:text-white"
          onClick={closeModal}
        >
          ×
        </button>
      </ModalHeader>
      <ModalBody data-testid="mpc-calibration-modal">
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b pb-4 dark:border-gray-700">
            <div>
              <h3
                className="text-lg font-semibold text-gray-900 dark:text-white"
                data-testid="mpc-calibration-dataset"
                data-dataset-id={dataset?.id}
              >
                {dataset?.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {cases.length} cases captured · Target:{" "}
                {MPC_CALIBRATION_TARGET_CASE_COUNT}
              </p>
              <div
                className="mt-1 flex items-center gap-4 text-xs"
                data-testid="mpc-preference-sync-status"
              >
                <span className="text-gray-500 dark:text-gray-400">
                  Sync Target: {syncTargetLabel}
                </span>
                <span
                  className={
                    syncSaveStateLabel.includes("Dirty")
                      ? "text-orange-500 font-medium"
                      : "text-green-500"
                  }
                >
                  {syncSaveStateLabel}
                </span>
              </div>
              <div data-testid="mpc-calibration-linked-sync-status">
                <CalibrationSyncStatus status={calibrationSyncStatus} />
              </div>
              <CalibrationConnectionControls />
              {status ? (
                <p
                  className="mt-2 text-xs text-gray-600 dark:text-gray-300"
                  data-testid="mpc-calibration-status"
                >
                  {status}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                type="file"
                className="hidden"
                ref={importInputRef}
                data-testid="mpc-calibration-import-input"
                onChange={importFixture}
                accept=".json"
              />
              <Button
                color="light"
                size="sm"
                onClick={() => importInputRef.current?.click()}
                disabled={phase !== "idle"}
              >
                Import
              </Button>
              <Button
                color="light"
                size="sm"
                onClick={exportFixture}
                disabled={!dataset || cases.length === 0}
              >
                Export
              </Button>
              <Button
                color="purple"
                size="sm"
                onClick={runCalibration}
                data-testid="mpc-calibration-run"
                disabled={!dataset || cases.length === 0 || phase !== "idle"}
              >
                {phase === "running" ? (
                  <Spinner size="xs" className="mr-2" />
                ) : null}
                Run Evaluation (
                <span data-testid="mpc-calibration-scoreboard">
                  {runLabel(currentResult)}
                </span>
                )
              </Button>
            </div>
          </div>

          {card ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-md font-medium text-gray-900 dark:text-white">
                  Active Capture: {card.name}
                </h4>
                <div className="text-xs text-gray-500">
                  {captureState.candidates.length} candidates found
                </div>
              </div>

              <CardGrid>
                {/* Source Image */}
                <div className="rounded-lg border-2 border-dashed border-gray-300 p-3 dark:border-gray-600">
                  <div className="mb-2 text-center text-xs font-bold uppercase text-gray-500">
                    Source (Scryfall)
                  </div>
                  <div className="aspect-[63/88] overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800">
                    <CardImageSvg
                      id={`source-${card.uuid}`}
                      url={
                        captureState.imageRecord?.sourceUrl ||
                        captureState.imageRecord?.imageUrls?.[0]
                      }
                    />
                  </div>
                  <div className="mt-3 text-center text-xs text-gray-500">
                    Target match reference
                  </div>
                </div>

                {/* Candidate Gallery */}
                {captureState.candidates.map((candidate) => {
                  const rec = recommendations?.fullProcess.find(
                    (r) => r.card.identifier === candidate.identifier
                  );
                  const stats = prefModel?.sourceStats?.[candidate.sourceName];
                  const winRate = stats ? (stats.selections / stats.appearances) * 100 : null;
                  const alreadyCaptured =
                    card
                      ? capturedChoiceKeys.has(
                          buildCapturedChoiceKey({
                            name: card.name,
                            set: card.set,
                            number: card.number,
                            identifier: candidate.identifier,
                          }) ?? ""
                        )
                      : false;

                  return (
                    <div
                      key={candidate.identifier}
                      className={`rounded-lg border p-3 dark:border-gray-700 ${rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-300 dark:border-purple-800 shadow-sm' : 'bg-white dark:bg-gray-800 border-gray-200'}`}
                      data-testid={`mpc-calibration-candidate-${candidate.identifier}`}
                      data-image-state={
                        captureState.candidateImageStates.get(
                          candidate.identifier
                        ) ?? "loading"
                      }
                    >
                      <div className="aspect-[63/88] overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800 relative">
                        <CardImageSvg
                          id={`calibration-${candidate.identifier}`}
                          url={
                            candidate.smallThumbnailUrl ||
                            candidate.mediumThumbnailUrl
                          }
                          onLoad={() =>
                            markCandidateImageReady(candidate.identifier)
                          }
                          onError={() =>
                            markCandidateImageFailed(candidate.identifier)
                          }
                        />
                        {rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier && (
                           <div className="absolute top-2 right-2 bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-md">
                             TOP PICK
                           </div>
                        )}
                      </div>
                      <div className="mt-3 space-y-1">
                        <div className="text-sm font-medium text-gray-900 dark:text-white truncate" title={candidate.rawName}>
                          {candidate.rawName}
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                          <span>{candidate.sourceName}</span>
                          <span>{candidate.dpi} DPI</span>
                        </div>
                        {rec && (
                          <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 space-y-1">
                            <div className="flex justify-between text-[10px] font-semibold text-gray-600 dark:text-gray-300">
                              <span>Committee Score:</span>
                              <span className="text-purple-600 dark:text-purple-400">
                                {(rec.score ?? 0).toFixed(1)}
                              </span>
                            </div>

                            {/* Detailed Breakdown */}
                            {rec.breakdown && (
                              <div className="grid grid-cols-2 gap-x-2 text-[8px] text-gray-400 dark:text-gray-500 italic">
                                <div className="flex justify-between">
                                  <span>Meta:</span>
                                  <span>{rec.breakdown.metadata}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Visual:</span>
                                  <span>{rec.breakdown.visual.toFixed(0)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Pref:</span>
                                  <span>
                                    {rec.breakdown.preference.toFixed(0)}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span>DPI:</span>
                                  <span>{rec.breakdown.dpi.toFixed(1)}</span>
                                </div>
                              </div>
                            )}

                            {winRate !== null && (
                              <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 border-t border-gray-50 dark:border-gray-800 pt-1 mt-1">
                                <span>Source Win Rate:</span>
                                <span>{winRate.toFixed(1)}%</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <Button
                        className="mt-3 w-full"
                        size="xs"
                        color={rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier ? "purple" : "light"}
                        onClick={() => void captureCase(candidate)}
                        disabled={
                          alreadyCaptured ||
                          phase === "capturing" ||
                          phase === "running" ||
                          captureState.candidateImageStates.get(
                            candidate.identifier
                          ) !== "ready"
                        }
                      >
                        {alreadyCaptured
                          ? "Expected Choice Captured"
                          : "Use as Expected Choice"}
                      </Button>
                    </div>
                  );
                })}
              </CardGrid>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-md font-medium text-gray-900 dark:text-white">
                Frozen Cases ({cases.length})
              </h4>
              <Button
                color="light"
                onClick={compareAlgorithms}
                disabled={!dataset || phase !== "idle"}
              >
                Compare vs DPI Baseline
              </Button>
            </div>

            <div className="max-h-[300px] overflow-y-auto rounded-lg border dark:border-gray-700">
              <table className="w-full text-left text-sm text-gray-500 dark:text-gray-400">
                <thead className="bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-2">Card</th>
                    <th className="px-4 py-2">Selection Status</th>
                    <th className="px-4 py-2">DPI Baseline</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-gray-700">
                  {cases.map((calibrationCase) => {
                    const caseResult = currentResult?.cases.find(
                      (item) => item.caseId === calibrationCase.id
                    );
                    const comparisonDiff = comparisonResult?.diffs.find(
                      (diff) => diff.caseId === calibrationCase.id
                    );

                    return (
                      <tr key={calibrationCase.id}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {calibrationCase.source.name}
                          </div>
                          <div className="text-xs">
                            {(calibrationCase.source.set ?? "—").toUpperCase()}{" "}
                            · #{calibrationCase.source.collectorNumber ?? "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                            Expected:{" "}
                            <span className="text-green-600 dark:text-green-400">
                              {calibrationCase.expectedIdentifier}
                            </span>
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            Predicted:{" "}
                            <span className={caseResult && !caseResult.matched ? "text-red-600 dark:text-red-400 font-bold" : ""}>
                              {caseResult?.predictedIdentifier ?? "not run"}
                            </span>
                          </div>
                          {caseResult && !caseResult.matched && (
                            <div className="mt-1 text-[10px] text-red-500 font-semibold uppercase tracking-wider">
                              Committee Conflict
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            <div>
                              Baseline:{" "}
                              {comparisonDiff?.baselineIdentifier ?? "—"}
                            </div>
                            {comparisonDiff ? (
                              <div>
                                Current:{" "}
                                {comparisonDiff.candidateIdentifier ?? "—"}
                              </div>
                            ) : null}
                            {comparisonDiff && (
                              <div
                                className={
                                  comparisonDiff.improvement === "gain"
                                    ? "text-green-600 font-bold"
                                    : comparisonDiff.improvement === "loss"
                                      ? "text-red-600 font-bold"
                                      : ""
                                }
                              >
                                Result: {comparisonDiff.improvement}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {cases.length === 0 ? (
                <p className="p-8 text-center text-gray-500 italic">
                  No frozen cases yet. Capture one from the current card or
                  import a fixture.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </ModalBody>
    </Modal>
  );
}
