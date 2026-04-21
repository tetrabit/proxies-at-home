import { Button, Modal, ModalBody, ModalHeader, Spinner } from "flowbite-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { filterByExactName } from "@/helpers/mpcBulkUpgradeMatcher";
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
  createMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationDatasets,
  listMpcCalibrationRuns,
  MPC_CALIBRATION_TARGET_CASE_COUNT,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "@/helpers/mpcCalibrationStorage";
import {
  getActivePreferenceSyncTarget,
  getMpcPreferenceSyncStatus,
  subscribeToMpcPreferenceSyncStatus,
} from "@/helpers/mpcPreferenceSync";
import { CardGrid } from "@/components/common/CardGrid";
import { CardImageSvg } from "@/components/common/CardImageSvg";

const DEFAULT_DATASET_NAME = "MPC Calibration Harness";

type CaptureState = {
  imageRecord: Image | null;
  candidates: MpcAutofillCard[];
};

function runLabel(result: MpcCalibrationEvaluationResult | null) {
  if (!result) return `0/${MPC_CALIBRATION_TARGET_CASE_COUNT}`;
  return `${result.summary.matchedCases}/${result.summary.totalCases}`;
}

async function ensureCalibrationDataset(): Promise<MpcCalibrationDatasetRecord> {
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
  });
}

export function CalibrationModal() {
  const open = useCalibrationModalStore((state) => state.open);
  const card = useCalibrationModalStore((state) => state.card);
  const closeModal = useCalibrationModalStore((state) => state.closeModal);

  const [dataset, setDataset] = useState<MpcCalibrationDatasetRecord | null>(
    null
  );
  const [cases, setCases] = useState<MpcCalibrationCaseRecord[]>([]);
  const [runs, setRuns] = useState<MpcCalibrationRunRecord[]>([]);
  const [currentResult, setCurrentResult] =
    useState<MpcCalibrationEvaluationResult | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<MpcCalibrationComparisonResult | null>(null);
  const [captureState, setCaptureState] = useState<CaptureState>({
    imageRecord: null,
    candidates: [],
  });
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

  const refreshDataset = useCallback(async (datasetId: string) => {
    const [loadedCases, loadedRuns] = await Promise.all([
      listMpcCalibrationCases(datasetId),
      listMpcCalibrationRuns(datasetId),
    ]);
    setCases(loadedCases);
    setRuns(loadedRuns.sort((left, right) => right.createdAt - left.createdAt));
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToMpcPreferenceSyncStatus((syncStatus) => {
      setSyncTargetLabel(syncStatus.targetLabel);
      setSyncSaveStateLabel(syncStatus.saveStateLabel);
    });

    if (!open) {
      setStatus(null);
      setCaptureState({ imageRecord: null, candidates: [] });
      return unsubscribe;
    }

    void (async () => {
      setPhase("loading");
      const ensuredDataset = await ensureCalibrationDataset();
      const activeTarget = await getActivePreferenceSyncTarget();
      
      setDataset(ensuredDataset);
      setSyncTargetLabel(activeTarget ? activeTarget.describe() : "Unavailable");
      await refreshDataset(ensuredDataset.id);

      if (card?.imageId) {
        const [imageRecord, matches] = await Promise.all([
          db.images.get(card.imageId),
          searchMpcAutofill(card.name, "CARD", false),
        ]);
        setCaptureState({
          imageRecord: imageRecord ?? null,
          candidates: filterByExactName(matches, card.name),
        });
      } else {
        setCaptureState({ imageRecord: null, candidates: [] });
      }
      setPhase("idle");
    })();
    return unsubscribe;
  }, [open, card, refreshDataset]);

  const latestRun = useMemo(() => runs[0] ?? null, [runs]);

  const captureCase = useCallback(
    async (candidate: MpcAutofillCard) => {
      if (!dataset || !card) return;
      setPhase("capturing");
      setStatus(null);
      try {
        const captured = await captureMpcCalibrationCase({
          datasetId: dataset.id,
          card,
          imageRecord: captureState.imageRecord,
          candidates: captureState.candidates,
          expectedIdentifier: candidate.identifier,
        });
        await saveMpcCalibrationCase(captured.caseRecord);
        await saveMpcCalibrationAssets(captured.assets);
        await refreshDataset(dataset.id);
        setStatus(`Captured expected choice: ${candidate.name}`);
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Failed to capture case"
        );
      } finally {
        setPhase("idle");
      }
    },
    [card, captureState, dataset, refreshDataset]
  );

  const runCurrentAlgorithm = useCallback(async () => {
    if (!dataset) return;
    setPhase("running");
    setStatus(null);
    try {
      const [datasetCases, assets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      const result = await evaluateMpcCalibrationDataset(
        dataset,
        datasetCases,
        {
          id: "current",
          label: "Current algorithm",
        },
        assets
      );
      setCurrentResult(result);
      await saveMpcCalibrationRun({
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        algorithmId: result.algorithmId,
        algorithmLabel: result.algorithmLabel,
        summary: result.summary,
        results: toMpcCalibrationRunResults(result.cases),
      });
      await refreshDataset(dataset.id);
      setStatus(`Current algorithm scored ${runLabel(result)}`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to run calibration"
      );
    } finally {
      setPhase("idle");
    }
  }, [dataset, refreshDataset]);

  const compareAlgorithms = useCallback(async () => {
    if (!dataset) return;
    setPhase("running");
    setStatus(null);
    try {
      const [datasetCases, assets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      const result = await compareMpcCalibrationAlgorithms(
        dataset,
        datasetCases,
        {
          id: "dpi-baseline",
          label: "DPI fallback baseline",
          ssimCompare: async () => null,
          artMatchCompare: async () => null,
        },
        {
          id: "current",
          label: "Current algorithm",
        },
        assets
      );
      setComparisonResult(result);
      setStatus(
        `Comparison found ${result.diffs.filter((diff) => diff.changed).length} changed picks`
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to compare algorithms"
      );
    } finally {
      setPhase("idle");
    }
  }, [dataset]);

  const exportFixture = useCallback(async () => {
    if (!dataset) return;
    const fixture = await buildMpcCalibrationFixture(dataset.id);
    downloadMpcCalibrationFixture(fixture);
  }, [dataset]);

  const importFixture = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setPhase("importing");
      setStatus(null);
      try {
        const text = await file.text();
        const fixture = validateMpcCalibrationFixture(JSON.parse(text));
        const datasetId = await importMpcCalibrationFixture(fixture);
        const datasets = await listMpcCalibrationDatasets();
        const importedDataset =
          datasets.find((item) => item.id === datasetId) ?? null;
        setDataset(importedDataset);
        if (importedDataset) {
          await refreshDataset(importedDataset.id);
        }
        setStatus(`Imported fixture: ${fixture.dataset.name}`);
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Failed to import fixture"
        );
      } finally {
        setPhase("idle");
        if (importInputRef.current) {
          importInputRef.current.value = "";
        }
      }
    },
    [refreshDataset]
  );

  const runSummaryLabel = useMemo(
    () => runLabel(currentResult),
    [currentResult]
  );

  return (
    <Modal show={open} onClose={closeModal} size="7xl" dismissible>
      <ModalHeader>MPC Calibration Harness</ModalHeader>
      <ModalBody>
        <div className="space-y-6" data-testid="mpc-calibration-modal">
          <div className="flex flex-wrap gap-3">
            <Button
              color="purple"
              onClick={runCurrentAlgorithm}
              disabled={!dataset || phase !== "idle"}
              data-testid="mpc-calibration-run"
            >
              {phase === "running" ? (
                <Spinner size="sm" />
              ) : (
                "Run Current Algorithm"
              )}
            </Button>
            <Button
              color="light"
              onClick={compareAlgorithms}
              disabled={!dataset || phase !== "idle"}
            >
              Compare vs DPI Baseline
            </Button>
            <Button
              color="light"
              onClick={exportFixture}
              disabled={!dataset || phase !== "idle"}
            >
              Export Fixture
            </Button>
            <Button
              color="light"
              onClick={() => importInputRef.current?.click()}
              disabled={phase !== "idle"}
            >
              Import Fixture
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              data-testid="mpc-calibration-import-input"
              onChange={(event) =>
                void importFixture(event.target.files?.[0] ?? null)
              }
            />
          </div>

          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  Dataset: {dataset?.name ?? "Loading…"}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Cases captured: {cases.length}/
                  {dataset?.targetCaseCount ??
                    MPC_CALIBRATION_TARGET_CASE_COUNT}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400" data-testid="mpc-preference-sync-status">
                  Sync target: {syncTargetLabel ?? "Loading…"} · {syncSaveStateLabel}
                </div>
              </div>
              <div
                className="text-right"
                data-testid="mpc-calibration-scoreboard"
              >
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Current score
                </div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {runSummaryLabel}
                </div>
              </div>
            </div>
            {status ? (
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                {status}
              </p>
            ) : null}
            {latestRun ? (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Last saved run: {latestRun.summary.matchedCases}/
                {latestRun.summary.totalCases}
              </p>
            ) : null}
          </div>

          {card ? (
            <section className="space-y-3">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Capture current card
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Choose the correct MPC candidate for {card.name} to freeze it
                  into the calibration dataset.
                </p>
              </div>
              <CardGrid cardSize={0.7}>
                {captureState.candidates.map((candidate) => (
                  <div
                    key={candidate.identifier}
                    className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                    data-testid={`mpc-calibration-candidate-${candidate.identifier}`}
                  >
                    <div className="aspect-[63/88] overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800">
                      <CardImageSvg
                        id={`calibration-${candidate.identifier}`}
                        url={
                          candidate.smallThumbnailUrl ||
                          candidate.mediumThumbnailUrl
                        }
                      />
                    </div>
                    <div className="mt-3 space-y-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {candidate.rawName}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {candidate.sourceName} · {candidate.dpi} DPI
                      </div>
                    </div>
                    <Button
                      className="mt-3 w-full"
                      size="xs"
                      onClick={() => void captureCase(candidate)}
                      disabled={phase !== "idle"}
                    >
                      Use as Expected Choice
                    </Button>
                  </div>
                ))}
              </CardGrid>
            </section>
          ) : null}

          <section className="space-y-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Frozen cases
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Each case stores the frozen source snapshot, candidate pool,
                expected choice, and replay results.
              </p>
            </div>
            <div className="space-y-3">
              {cases.map((calibrationCase) => {
                const caseResult = currentResult?.cases.find(
                  (item) => item.caseId === calibrationCase.id
                );
                const comparisonDiff = comparisonResult?.diffs.find(
                  (diff) => diff.caseId === calibrationCase.id
                );
                return (
                  <div
                    key={calibrationCase.id}
                    className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                    data-testid={`mpc-calibration-case-${calibrationCase.id}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-medium text-gray-900 dark:text-white">
                          {calibrationCase.source.name}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          Expected:{" "}
                          {calibrationCase.expectedIdentifier ?? "unset"}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          Predicted:{" "}
                          {caseResult?.predictedIdentifier ?? "not run"}
                        </div>
                        {comparisonDiff ? (
                          <div className="mt-2 rounded-md bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            <div>
                              Baseline:{" "}
                              {comparisonDiff.baselineIdentifier ?? "—"}
                            </div>
                            <div>
                              Current:{" "}
                              {comparisonDiff.candidateIdentifier ?? "—"}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="text-right text-sm">
                        <div
                          className={
                            caseResult?.matched
                              ? "text-green-600 dark:text-green-400"
                              : "text-gray-500 dark:text-gray-400"
                          }
                        >
                          {caseResult
                            ? caseResult.matched
                              ? "PASS"
                              : "FAIL"
                            : "—"}
                        </div>
                        {comparisonDiff?.changed ? (
                          <div className="text-amber-600 dark:text-amber-400">
                            Compare changed
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              {cases.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
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
