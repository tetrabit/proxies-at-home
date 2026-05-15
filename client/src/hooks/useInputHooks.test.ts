import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNormalizedInput, usePositionInput } from "./useInputHooks";

describe("useInputHooks", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    describe("useNormalizedInput", () => {
        it("should initialize with default value", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => useNormalizedInput(10, onChange));

            expect(result.current.defaultValue).toBe(10);
            expect(result.current.inputRef).toBeDefined();
            expect(result.current.warning).toBeNull();
        });

        it("should handle change events and normalize comma to dot", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => useNormalizedInput(0, onChange));

            const mockEvent = {
                target: { value: "3,5" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(3.5);
        });

        it("should clamp values to min", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() =>
                useNormalizedInput(5, onChange, { min: 1, max: 10 })
            );

            const mockEvent = {
                target: { value: "-5" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(1);
            expect(result.current.warning).not.toBeNull();
        });

        it("should clamp values to max", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() =>
                useNormalizedInput(5, onChange, { min: 1, max: 10 })
            );

            const mockEvent = {
                target: { value: "100" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(10);
            expect(result.current.warning).not.toBeNull();
        });

        it("should handle integer mode", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() =>
                useNormalizedInput(0, onChange, { isInteger: true })
            );

            const mockEvent = {
                target: { value: "5.9" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(5);
        });

        it("should remove leading zeros", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => useNormalizedInput(0, onChange));

            const mockEvent = {
                target: { value: "007" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(7);
        });

        it("should not remove leading zero before decimal", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => useNormalizedInput(0, onChange));

            const mockEvent = {
                target: { value: "0.5" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(0.5);
        });

        it("should restore the placeholder value on blur when the field is empty", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => useNormalizedInput(10, onChange));
            const event = {
                target: {
                    value: "",
                    placeholder: "10",
                },
            } as React.FocusEvent<HTMLInputElement>;

            act(() => {
                result.current.handleBlur(event);
            });

            expect(event.target.value).toBe("10");
            expect(onChange).toHaveBeenCalledWith(10);
        });

        it("should clear clamp warnings after the timeout", async () => {
            vi.useFakeTimers();

            const onChange = vi.fn();
            const { result } = renderHook(() =>
                useNormalizedInput(5, onChange, { min: 1, max: 10 })
            );

            act(() => {
                result.current.handleChange({
                    target: { value: "100" },
                } as React.ChangeEvent<HTMLInputElement>);
            });

            expect(result.current.warning).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });

            expect(result.current.warning).toBeNull();
        });
    });

    describe("usePositionInput", () => {
        it("should initialize with default value as string", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => usePositionInput(10, onChange));

            expect(result.current.defaultValue).toBe("10");
            expect(result.current.inputRef).toBeDefined();
        });

        it("should handle negative values", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => usePositionInput(0, onChange));

            const mockEvent = {
                target: { value: "-5" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(-5);
        });

        it("should normalize comma to dot", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => usePositionInput(0, onChange));

            const mockEvent = {
                target: { value: "-3,5" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).toHaveBeenCalledWith(-3.5);
        });

        it("should not call onChange for empty value", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => usePositionInput(0, onChange));

            const mockEvent = {
                target: { value: "" },
            } as React.ChangeEvent<HTMLInputElement>;

            act(() => {
                result.current.handleChange(mockEvent);
            });

            expect(onChange).not.toHaveBeenCalled();
        });

        it("should restore the placeholder value on blur when empty", () => {
            const onChange = vi.fn();
            const { result } = renderHook(() => usePositionInput(12, onChange));
            const event = {
                target: {
                    value: "",
                    placeholder: "12",
                },
            } as React.FocusEvent<HTMLInputElement>;

            act(() => {
                result.current.handleBlur(event);
            });

            expect(event.target.value).toBe("12");
            expect(onChange).toHaveBeenCalledWith(12);
        });
    });
});
