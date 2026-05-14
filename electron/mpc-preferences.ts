export interface MpcPreferenceCandidate {
  identifier: string;
  name: string;
  rawName: string;
  smallThumbnailUrl: string;
  mediumThumbnailUrl: string;
  imageUrl?: string;
  dpi: number;
  tags: string[];
  sourceName: string;
  source: string;
  extension: string;
  size: number;
}

export interface MpcPreferenceCase {
  source: {
    name: string;
    set?: string;
    collectorNumber?: string;
    sourceImageUrl?: string;
    sourceArtImageUrl?: string;
  };
  candidates: MpcPreferenceCandidate[];
  expectedIdentifier?: string;
  notes?: string;
  comparisonHints?: {
    fullCard?: Record<string, number | null>;
    artMatch?: Record<string, number | null>;
  };
}

export interface MpcPreferenceFixture {
  version: number;
  exportedAt: string;
  cases: MpcPreferenceCase[];
}
