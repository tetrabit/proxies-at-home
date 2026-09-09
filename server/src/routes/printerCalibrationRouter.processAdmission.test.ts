import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalibrationProcessAdmission } from "./calibrationProcessAdmission.js";

const childProcessState = vi.hoisted(() => ({
  children: [] as unknown[],
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({ spawn: childProcessState.spawn }));

import { __printerCalibrationTestInternals } from "./printerCalibrationRouter.js";

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  kill: ReturnType<typeof vi.fn>;
};

function child(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
}

afterEach(() => {
  vi.useRealTimers();
  childProcessState.children = [];
  childProcessState.spawn.mockReset();
});

describe("printer calibration subprocess admission", () => {
  it("builds a bounded admission queue from finite process configuration", async () => {
    const admission = __printerCalibrationTestInternals.createConfiguredCalibrationProcessAdmission({
      PRINTER_CALIBRATION_MAX_ACTIVE_PYTHON: "1",
      PRINTER_CALIBRATION_MAX_QUEUED_PYTHON: "0",
    });

    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
    let release!: () => void;
    const active = admission.enqueue(
      () => new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    expect(() => admission.enqueue(async () => undefined)).toThrow("process queue is full");
    release();
    await active;
    expect(() =>
      __printerCalibrationTestInternals.createConfiguredCalibrationProcessAdmission({
        PRINTER_CALIBRATION_MAX_ACTIVE_PYTHON: "Infinity",
      })
    ).toThrow("PRINTER_CALIBRATION_MAX_ACTIVE_PYTHON must be a finite integer");
  });

  it("retains a process slot after timeout kill until that owned child closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const admission = createCalibrationProcessAdmission({ maxActive: 1, maxQueued: 1 });
    const firstChild = child();
    const secondChild = child();
    childProcessState.children = [firstChild, secondChild];
    childProcessState.spawn.mockImplementation(() => childProcessState.children.shift());

    const first = __printerCalibrationTestInternals.runProcess("python", [], {
      timeoutMs: 100,
      admission,
    });
    const second = __printerCalibrationTestInternals.runProcess("python", [], {
      timeoutMs: 100,
      admission,
    });
    const secondTimeout = expect(second).rejects.toThrow("timed out after 100ms");

    expect(childProcessState.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(childProcessState.spawn).toHaveBeenCalledTimes(1);
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });

    firstChild.emit("error", new Error("kill reported before close"));
    await Promise.resolve();
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });
    firstChild.emit("close", null);
    await expect(first).rejects.toThrow("timed out after 100ms");
    await secondTimeout;
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("cancels a queued subprocess before spawn", async () => {
    const admission = createCalibrationProcessAdmission({ maxActive: 1, maxQueued: 1 });
    const activeChild = child();
    childProcessState.children = [activeChild];
    childProcessState.spawn.mockImplementation(() => childProcessState.children.shift());
    const controller = new AbortController();

    const active = __printerCalibrationTestInternals.runProcess("python", [], { admission });
    const queued = __printerCalibrationTestInternals.runProcess("python", [], {
      admission,
      signal: controller.signal,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(childProcessState.spawn).toHaveBeenCalledTimes(1);
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });

    activeChild.emit("close", 0);
    await expect(active).resolves.toMatchObject({ code: 0 });
  });
});
