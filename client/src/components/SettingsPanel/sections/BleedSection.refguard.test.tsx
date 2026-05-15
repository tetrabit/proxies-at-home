import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockState = vi.hoisted(() => ({
    bleedEdgeWidth: 25.4,
    bleedEdge: true,
    bleedEdgeUnit: 'mm' as 'mm' | 'in',
    withBleedSourceAmount: 3.175,
    withBleedTargetMode: 'global' as 'global' | 'manual' | 'none',
    withBleedTargetAmount: 3,
    noBleedTargetMode: 'global' as 'global' | 'manual' | 'none',
    noBleedTargetAmount: 3,
}));

const mockSetters = vi.hoisted(() => ({
    setBleedEdgeWidth: vi.fn(),
    setBleedEdge: vi.fn(),
    setBleedEdgeUnit: vi.fn(),
    setWithBleedSourceAmount: vi.fn(),
    setWithBleedTargetMode: vi.fn(),
    setWithBleedTargetAmount: vi.fn(),
    setNoBleedTargetMode: vi.fn(),
    setNoBleedTargetAmount: vi.fn(),
}));

vi.mock('@/store/settings', () => ({
    useSettingsStore: vi.fn((selector) => selector({
        bleedEdgeWidth: mockState.bleedEdgeWidth,
        bleedEdge: mockState.bleedEdge,
        bleedEdgeUnit: mockState.bleedEdgeUnit,
        withBleedSourceAmount: mockState.withBleedSourceAmount,
        withBleedTargetMode: mockState.withBleedTargetMode,
        withBleedTargetAmount: mockState.withBleedTargetAmount,
        noBleedTargetMode: mockState.noBleedTargetMode,
        noBleedTargetAmount: mockState.noBleedTargetAmount,
        ...mockSetters,
    })),
}));

vi.mock('flowbite-react', () => ({
    Label: ({ children, htmlFor, className }: { children: React.ReactNode; htmlFor?: string; className?: string }) => (
        <label htmlFor={htmlFor} className={className}>{children}</label>
    ),
    Select: ({ value, onChange, disabled, children, className }: { value: string; onChange: (e: { target: { value: string } }) => void; disabled?: boolean; children: React.ReactNode; className?: string }) => (
        <select data-testid="unit-select" value={value} onChange={onChange} disabled={disabled} className={className}>
            {children}
        </select>
    ),
    Checkbox: ({ id, checked, onChange }: { id: string; checked: boolean; onChange: (e: { target: { checked: boolean } }) => void }) => (
        <input type="checkbox" id={id} data-testid={id} checked={checked} onChange={(e) => onChange({ target: { checked: e.target.checked } })} />
    ),
}));

vi.mock('@/components/common', () => ({
    NumberInput: ({ disabled, defaultValue, onChange, onBlur, className, step }: { disabled?: boolean; defaultValue?: number; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void; onBlur?: () => void; className?: string; step?: number }) => {
        return (
            <input data-testid="bleed-width-input" type="number" disabled={disabled} defaultValue={defaultValue} onChange={onChange} onBlur={onBlur} className={className} step={step} />
        );
    },
}));

vi.mock('@/hooks/useInputHooks', () => {
    const nullRef = {};
    Object.defineProperty(nullRef, 'current', {
        configurable: true,
        enumerable: true,
        get: () => null,
        set: () => undefined,
    });

    return {
        useNormalizedInput: (value: number, onChange: (v: number) => void) => ({
            inputRef: nullRef,
            defaultValue: value,
            handleChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) onChange(val);
            },
            handleBlur: vi.fn(),
        }),
    };
});

vi.mock('lucide-react', () => ({
    ChevronDown: () => <span data-testid="chevron-down">▼</span>,
    ChevronUp: () => <span data-testid="chevron-up">▲</span>,
}));

vi.mock('@/components/CardEditorModal/SourceBleedInput', () => ({
    SourceBleedInput: ({ valueMm, onChangeMm }: { valueMm: number; onChangeMm: (v: number) => void }) => (
        <div data-testid="source-bleed-input" data-value={valueMm}>
            <input type="number" onChange={(e) => onChangeMm(parseFloat(e.target.value))} />
        </div>
    ),
}));

vi.mock('@/components/CardEditorModal/BleedModeControl', () => ({
    BleedModeControl: ({ idPrefix, mode, onModeChange, amount, onAmountChange }: { idPrefix: string; mode: string; onModeChange: (m: string) => void; amount: number; onAmountChange: (v: number) => void; groupName?: string }) => (
        <div data-testid={`bleed-mode-control-${idPrefix}`} data-mode={mode} data-amount={amount}>
            <button onClick={() => onModeChange('manual')}>Manual</button>
            <input type="number" onChange={(e) => onAmountChange(parseFloat(e.target.value))} />
        </div>
    ),
}));

import { BleedSection } from "./BleedSection";

describe("BleedSection ref guard", () => {
    it("keeps converting units when the normalized input ref is unavailable", () => {
        render(<BleedSection />);

        fireEvent.change(screen.getByTestId("unit-select"), { target: { value: "in" } });

        expect(mockSetters.setBleedEdgeWidth).toHaveBeenCalledWith(1);
        expect((screen.getByTestId("bleed-width-input") as HTMLInputElement).value).toBe("25.4");
    });
});
