export type DuplexPageLimitSplit = {
  frontMaxPages?: number;
  backMaxPages?: number;
};

export function parsePdfPageLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;

  return Math.max(1, Math.floor(parsed));
}

export function formatPdfPageLimitInput(value: string): string {
  const parsed = parsePdfPageLimit(value);
  return parsed === undefined ? "" : String(parsed);
}

export function countExportPages(itemCount: number, perPage: number): number {
  if (itemCount <= 0) return 0;
  const safePerPage = Math.max(1, Math.floor(perPage));
  return Math.ceil(itemCount / safePerPage);
}

export function splitGroupedDuplexPageLimit(
  pageLimit: number | undefined,
  frontPageCount: number,
  backPageCount: number
): DuplexPageLimitSplit {
  if (pageLimit === undefined) return {};

  const safeLimit = Math.max(0, Math.floor(pageLimit));
  const safeFrontPageCount = Math.max(0, Math.floor(frontPageCount));
  const safeBackPageCount = Math.max(0, Math.floor(backPageCount));

  const frontMaxPages = Math.min(safeFrontPageCount, safeLimit);
  const backMaxPages = Math.min(
    safeBackPageCount,
    Math.max(0, safeLimit - safeFrontPageCount)
  );

  return { frontMaxPages, backMaxPages };
}

export function splitCollatedDuplexPageLimit(
  pageLimit: number | undefined,
  frontPageCount: number,
  backPageCount: number
): DuplexPageLimitSplit {
  if (pageLimit === undefined) return {};

  const safeLimit = Math.max(0, Math.floor(pageLimit));
  const safeFrontPageCount = Math.max(0, Math.floor(frontPageCount));
  const safeBackPageCount = Math.max(0, Math.floor(backPageCount));

  let frontMaxPages = 0;
  let backMaxPages = 0;
  let outputPages = 0;
  const maxPagePairs = Math.max(safeFrontPageCount, safeBackPageCount);

  for (let i = 0; i < maxPagePairs && outputPages < safeLimit; i++) {
    if (i < safeFrontPageCount && outputPages < safeLimit) {
      frontMaxPages = i + 1;
      outputPages++;
    }

    if (i < safeBackPageCount && outputPages < safeLimit) {
      backMaxPages = i + 1;
      outputPages++;
    }
  }

  return { frontMaxPages, backMaxPages };
}
