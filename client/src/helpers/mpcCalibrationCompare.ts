import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";
import {
  evaluateMpcCalibrationDataset,
  type MpcCalibrationAlgorithmConfig,
  type MpcCalibrationEvaluationResult,
} from "./mpcCalibrationRunner";

export interface MpcCalibrationCaseComparison {
  caseId: string;
  baselineIdentifier?: string;
  candidateIdentifier?: string;
  changed: boolean;
  expectedIdentifier?: string;
}

export interface MpcCalibrationComparisonResult {
  baseline: MpcCalibrationEvaluationResult;
  candidate: MpcCalibrationEvaluationResult;
  diffs: MpcCalibrationCaseComparison[];
}

export async function compareMpcCalibrationAlgorithms(
  dataset: MpcCalibrationDatasetRecord,
  cases: MpcCalibrationCaseRecord[],
  baseline: MpcCalibrationAlgorithmConfig,
  candidate: MpcCalibrationAlgorithmConfig,
  assets?: MpcCalibrationAssetRecord[]
): Promise<MpcCalibrationComparisonResult> {
  const baselineResult = await evaluateMpcCalibrationDataset(
    dataset,
    cases,
    baseline,
    assets
  );
  const candidateResult = await evaluateMpcCalibrationDataset(
    dataset,
    cases,
    candidate,
    assets
  );

  const diffs = cases.map((calibrationCase) => {
    const left = baselineResult.cases.find(
      (item) => item.caseId === calibrationCase.id
    );
    const right = candidateResult.cases.find(
      (item) => item.caseId === calibrationCase.id
    );

    return {
      caseId: calibrationCase.id,
      baselineIdentifier: left?.predictedIdentifier,
      candidateIdentifier: right?.predictedIdentifier,
      changed: left?.predictedIdentifier !== right?.predictedIdentifier,
      expectedIdentifier: calibrationCase.expectedIdentifier,
    };
  });

  return {
    baseline: baselineResult,
    candidate: candidateResult,
    diffs,
  };
}
