import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MPC_PREFERENCE_FIXTURE_VERSION,
  parseMpcPreferenceFixtureForPromotion,
} from "./preferenceFixtureValidation";

type LegacyFixture = {
  cases: Array<{
    name: string;
    expectedIdentifier?: string;
    candidates: Array<Record<string, unknown>>;
  }>;
};

async function loadCheckedInFixture(): Promise<LegacyFixture> {
  const fixturePath = fileURLToPath(
    new URL("../client/tests/fixtures/mpc-preference-defaults.v1.json", import.meta.url)
  );
  return JSON.parse(await readFile(fixturePath, "utf8")) as LegacyFixture;
}

describe("parseMpcPreferenceFixtureForPromotion", () => {
  it("imports and parses the checked-in legacy fixture in Node", async () => {
    expect(typeof document).toBe("undefined");
    const fixture = await loadCheckedInFixture();

    const parsed = parseMpcPreferenceFixtureForPromotion(fixture);

    expect(parsed).toEqual({
      cases: fixture.cases.map(({ name, expectedIdentifier, candidates }) => ({
        name,
        ...(expectedIdentifier !== undefined ? { expectedIdentifier } : {}),
        candidates,
      })),
    });
  });

  it("normalizes a supported versioned fixture without retaining transport metadata", async () => {
    const fixture = await loadCheckedInFixture();
    const candidate = fixture.cases[0]?.candidates[0];
    expect(candidate).toBeDefined();

    const parsed = parseMpcPreferenceFixtureForPromotion({
      version: MPC_PREFERENCE_FIXTURE_VERSION,
      exportedAt: "2026-09-09T00:00:00.000Z",
      cases: [
        {
          source: {
            name: "Thalia, Guardian of Thraben",
            set: "dka",
            collectorNumber: "24",
          },
          expectedIdentifier: fixture.cases[0]?.expectedIdentifier,
          candidates: [candidate],
        },
      ],
    });

    expect(parsed).toEqual({
      cases: [
        {
          name: "Thalia, Guardian of Thraben",
          expectedIdentifier: fixture.cases[0]?.expectedIdentifier,
          candidates: [candidate],
        },
      ],
    });
  });

  it("rejects unsupported fixture versions", async () => {
    const fixture = await loadCheckedInFixture();

    expect(() =>
      parseMpcPreferenceFixtureForPromotion({
        version: MPC_PREFERENCE_FIXTURE_VERSION + 1,
        exportedAt: "2026-09-09T00:00:00.000Z",
        cases: fixture.cases,
      })
    ).toThrow("Unsupported preference fixture version: 2");
  });

  it("rejects malformed nested source and candidate fields", async () => {
    const fixture = await loadCheckedInFixture();
    const candidate = fixture.cases[0]?.candidates[0];
    expect(candidate).toBeDefined();

    expect(() =>
      parseMpcPreferenceFixtureForPromotion({
        version: MPC_PREFERENCE_FIXTURE_VERSION,
        exportedAt: "2026-09-09T00:00:00.000Z",
        cases: [
          {
            source: { name: "Thalia, Guardian of Thraben", set: 24 },
            candidates: [candidate],
          },
        ],
      })
    ).toThrow("Invalid preference fixture: malformed source card");

    expect(() =>
      parseMpcPreferenceFixtureForPromotion({
        cases: [
          {
            name: "Thalia, Guardian of Thraben",
            candidates: [{ ...candidate, tags: ["valid", 1] }],
          },
        ],
      })
    ).toThrow("Invalid preference fixture: malformed candidate");
  });
});
