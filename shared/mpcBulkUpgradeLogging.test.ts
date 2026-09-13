import { describe, expect, it } from "vitest";
import {
  formatMpcBulkLogEvent,
  MPC_BULK_LOG_EVENTS,
  MPC_BULK_LOG_MAX_LENGTH,
  MPC_BULK_LOG_PREFIX,
  parseMpcBulkLogMessage,
  type MpcBulkLogEvent,
} from "./mpcBulkUpgradeLogging";

const event: MpcBulkLogEvent = {
  event: "phase-started", runId: "run-1", elapsedMs: 12,
  phase: "searching-mpc", queryCount: 3, cardType: "CARD",
};

const wire = (value: unknown) => MPC_BULK_LOG_PREFIX + JSON.stringify(value);

describe("MPC bulk log wire format", () => {
  it("formats a single readable, correlated JSON line and round-trips it", () => {
    const line = formatMpcBulkLogEvent(event);
    expect(line).toBe(wire(event));
    expect(parseMpcBulkLogMessage(line)).toEqual(event);
  });

  it.each(MPC_BULK_LOG_EVENTS)("accepts the %s lifecycle event", (name) => {
    expect(parseMpcBulkLogMessage(wire({ ...event, event: name }))?.event).toBe(name);
  });

  it.each([
    "ordinary renderer message", "[MPC Bulk Upgrade] not JSON", null,
    wire([]), wire({ ...event, event: "arbitrary-command" }),
    wire({ ...event, runId: "" }), wire({ ...event, runId: "run\nforged" }),
    wire({ ...event, elapsedMs: -1 }), wire({ ...event, queryCount: -1 }),
    wire({ ...event, queryCount: 1.5 }), wire({ ...event, phase: {} }),
    wire({ ...event, credential: "synthetic-secret" }),
    MPC_BULK_LOG_PREFIX + "x".repeat(MPC_BULK_LOG_MAX_LENGTH),
    MPC_BULK_LOG_PREFIX + '{"event":"started","runId":"run-1","elapsedMs":0,"__proto__":{}}',
  ])("rejects unrelated, malformed or unbounded payload %j", (message) => {
    expect(parseMpcBulkLogMessage(message)).toBeNull();
  });

  it("bounds and sanitizes text before writing it to a terminal", () => {
    const line = formatMpcBulkLogEvent({ ...event, cardName: "Sol Ring\n\x1b[31m" + "x".repeat(500) });
    expect(["\n", "\r", "\x1b"].some(control => line.includes(control))).toBe(false);
    const decoded = parseMpcBulkLogMessage(line)!;
    expect(decoded.cardName?.startsWith("Sol Ring")).toBe(true);
    expect(decoded.cardName!.length).toBeLessThanOrEqual(160);
    expect(line.length).toBeLessThanOrEqual(MPC_BULK_LOG_MAX_LENGTH);
  });

  it("redacts URLs and credential-shaped text on encoding and native parsing", () => {
    const secret = "calibration_pair_" + "x".repeat(43);
    const dirty = { ...event, cardName: `https://example.invalid/?token=sentinel ${secret}`, sourceName: "Bearer synthetic-secret" };
    for (const decoded of [parseMpcBulkLogMessage(formatMpcBulkLogEvent(dirty)), parseMpcBulkLogMessage(wire(dirty))]) {
      expect(decoded).not.toBeNull();
      expect(JSON.stringify(decoded)).not.toMatch(/sentinel|calibration_pair_|synthetic-secret|https:\/\//);
    }
  });

  it("refuses extra fields rather than serializing errors or blobs", () => {
    expect(() => formatMpcBulkLogEvent({ ...event, payload: { credential: "synthetic-secret" } } as MpcBulkLogEvent)).toThrow();
    expect(() => formatMpcBulkLogEvent({ ...event, elapsedMs: Number.NaN })).toThrow();
  });
});
