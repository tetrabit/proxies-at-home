import type {
  RankedCandidate,
  RankedRecommendations,
} from "./mpcBulkUpgradeMatcher";

export type LayerKey =
  | "fullProcess"
  | "exactPrinting"
  | "artMatch"
  | "fullCard"
  | "allMatches";

export interface LayerTab {
  key: LayerKey;
  label: string;
  candidates: RankedCandidate[];
  count: number;
}

const LAYER_ORDER: readonly LayerKey[] = [
  "fullProcess",
  "exactPrinting",
  "artMatch",
  "fullCard",
  "allMatches",
] as const;

const LAYER_LABELS: Record<LayerKey, string> = {
  fullProcess: "Full Process",
  exactPrinting: "Exact Printing",
  artMatch: "Art Match",
  fullCard: "Full Card",
  allMatches: "All Matches",
};

export function buildLayerTabs(
  recommendations: RankedRecommendations
): LayerTab[] {
  return LAYER_ORDER.map((key) => {
    const candidates = recommendations[key];

    return {
      key,
      label: LAYER_LABELS[key],
      candidates,
      count: candidates.length,
    };
  });
}

export function getLayerLabel(key: LayerKey): string {
  return LAYER_LABELS[key];
}
