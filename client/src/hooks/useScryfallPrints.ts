import { useState, useRef, useEffect } from "react";
import { debugLog } from "@/helpers/debug";
import { API_BASE } from "@/constants";
import type { PrintInfo } from "@/types";
import { db } from "@/db";

export interface ScryfallPrintsResult {
  /** Array of print metadata */
  prints: PrintInfo[];
  /** Whether a fetch is currently in progress */
  isLoading: boolean;
  /** Whether at least one fetch has been performed */
  hasSearched: boolean;
  /** Whether there are any results */
  hasResults: boolean;
}

export interface UseScryfallPrintsOptions {
  name: string;
  oracleId?: string;
  set?: string;
  number?: string;
  lang?: string;
  enabled?: boolean;
  initialPrints?: PrintInfo[];
}

/**
 * Hook for fetching all prints of a specific card with full metadata.
 * Returns prints[] with faceName for DFC filtering.
 *
 * @param cardName - Exact card name to fetch prints for
 * @param options - Configuration options
 * @returns ScryfallPrintsResult with prints, loading state, and fetch status
 */
export function useScryfallPrints({
  name,
  oracleId,
  set,
  number,
  lang = "en",
  enabled = true,
  initialPrints,
}: UseScryfallPrintsOptions): ScryfallPrintsResult {
  const [prints, setPrints] = useState<PrintInfo[]>(initialPrints || []);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(
    !!initialPrints && initialPrints.length > 0
  );

  // Refs for request management
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestKeyRef = useRef<string>("");

  // Fetch effect
  useEffect(() => {
    const trimmedName = name?.trim() ?? "";
    const normalizedOracleId = oracleId?.trim();
    const normalizedSet = set?.trim().toLowerCase();
    const normalizedNumber = number?.trim();
    const hasName = trimmedName.length > 0;
    const hasSetAndNumber = !!normalizedSet && !!normalizedNumber;

    // Don't fetch if disabled or no usable lookup identity
    if (!enabled || (!normalizedOracleId && !hasSetAndNumber && !hasName)) {
      return;
    }

    const requestKey = normalizedOracleId
      ? `oracle:${normalizedOracleId}|lang:${lang}`
      : hasSetAndNumber
        ? `print:${normalizedSet}|${normalizedNumber}|name:${trimmedName}|lang:${lang}`
        : `name:${trimmedName}|lang:${lang}`;

    // Skip if same lookup requested
    if (currentRequestKeyRef.current === requestKey && hasSearched) return;

    const performFetch = async () => {
      currentRequestKeyRef.current = requestKey;

      // Abort any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new abort controller
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        // 1. Check Local DB (Metatadata Cache)
        // We verify 'hasFullPrints' to ensure we have the complete list
        let cached =
          normalizedOracleId
            ? await db.cardMetadataCache
              .where("oracle_id")
              .equals(normalizedOracleId)
              .first()
            : undefined;

        if (!cached && hasSetAndNumber) {
          cached = await db.cardMetadataCache
            .where("set")
            .equals(normalizedSet)
            .and((item) =>
              item.number === normalizedNumber &&
              (!hasName || item.name === trimmedName)
            )
            .first();
        }

        if (!cached && hasName) {
          cached = await db.cardMetadataCache
            .where("name")
            .equals(trimmedName)
            .first();
        }

        if (
          cached &&
          cached.hasFullPrints &&
          Array.isArray(cached.data?.prints) &&
          cached.data.prints.length > 0
        ) {
          // Cache Hit!
          debugLog("[ScryfallPrints] Local cache HIT for:", requestKey);
          if (currentRequestKeyRef.current === requestKey) {
            setPrints(cached.data.prints);
            setHasSearched(true);
            return; // Done, no network needed
          }
        }

        // 2. Network Fetch (Cache Miss)
        setIsLoading(true);
        const params = new URLSearchParams({ lang });
        if (normalizedOracleId) {
          params.set("oracle_id", normalizedOracleId);
        } else if (hasSetAndNumber) {
          params.set("set", normalizedSet);
          params.set("number", normalizedNumber);
          if (hasName) params.set("name", trimmedName);
        } else {
          params.set("name", trimmedName);
        }
        const url = `${API_BASE}/api/scryfall/prints?${params.toString()}`;

        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
        });

        if (currentRequestKeyRef.current !== requestKey) return;

        if (response.ok) {
          const data = await response.json();
          debugLog("[ScryfallPrints] Fetched prints:", data.total);

          let resultPrints: PrintInfo[] = data.prints || [];
          const resolvedOracleId =
            (
              typeof data.oracle_id === "string"
                ? data.oracle_id.trim()
                : undefined
            ) ||
            resultPrints.find((p) => typeof p.oracle_id === "string")?.oracle_id;

          // Two-phase lookup: when we opened with print identity (set+number),
          // follow up with oracle_id to load full alternative arts.
          if (!normalizedOracleId && hasSetAndNumber && resolvedOracleId) {
            const oracleParams = new URLSearchParams({
              lang,
              oracle_id: resolvedOracleId,
            });
            const oracleUrl = `${API_BASE}/api/scryfall/prints?${oracleParams.toString()}`;
            const oracleResponse = await fetch(oracleUrl, {
              signal: controller.signal,
              cache: "no-store",
            });

            if (currentRequestKeyRef.current !== requestKey) return;

            if (oracleResponse.ok) {
              const oracleData = await oracleResponse.json();
              const oraclePrints: PrintInfo[] = oracleData.prints || [];
              if (oraclePrints.length > 0) {
                resultPrints = oraclePrints;
              }
            }
          }

          // 3. Update Local DB
          const updateEntries = (entry: {
            hasFullPrints?: boolean;
            data: unknown;
          }) => {
            entry.hasFullPrints = true;
            if (typeof entry.data === "object" && entry.data !== null) {
              entry.data = { ...(entry.data as Record<string, unknown>), prints: resultPrints };
            } else {
              entry.data = { prints: resultPrints };
            }
          };

          if (normalizedOracleId) {
            await db.cardMetadataCache
              .where("oracle_id")
              .equals(normalizedOracleId)
              .modify(updateEntries);
          } else if (hasSetAndNumber) {
            await db.cardMetadataCache
              .where("set")
              .equals(normalizedSet)
              .and((entry) =>
                entry.number === normalizedNumber &&
                (!hasName || entry.name === trimmedName)
              )
              .modify(updateEntries);
          } else if (hasName) {
            await db.cardMetadataCache
              .where("name")
              .equals(trimmedName)
              .modify(updateEntries);
          }

          setPrints(resultPrints);
          setHasSearched(true);
        } else {
          console.error(
            "[ScryfallPrints] Error fetching prints:",
            response.status
          );
          setPrints([]);
          setHasSearched(true);
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          debugLog("[ScryfallPrints] Fetch error:", err);
          setPrints([]);
          setHasSearched(true);
        }
      } finally {
        if (currentRequestKeyRef.current === requestKey) {
          setIsLoading(false);
        }
      }
    };

    // Small debounce
    const timeoutId = setTimeout(performFetch, 100);

    return () => {
      clearTimeout(timeoutId);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [name, oracleId, set, number, lang, enabled, hasSearched, initialPrints]);

  return {
    prints,
    isLoading,
    hasSearched,
    hasResults: prints.length > 0,
  };
}
