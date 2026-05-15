import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('flowbite-react', () => ({
    TextInput: ({ type, min, max, step, onChange, className, ...props }: { type?: string; min?: number; max?: number; step?: number; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void; className?: string }) => (
        <input type={type} min={min} max={max} step={step} onChange={onChange} className={className} data-testid="text-input" {...props} />
    ),
}));

vi.mock('lucide-react', () => ({
    ChevronUp: ({ className }: { className?: string }) => <span data-testid="chevron-up" className={className}>▲</span>,
    ChevronDown: ({ className }: { className?: string }) => <span data-testid="chevron-down" className={className}>▼</span>,
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    const nullRef = {};
    Object.defineProperty(nullRef, 'current', {
        configurable: true,
        enumerable: true,
        get: () => null,
        set: () => undefined,
    });
    return {
        ...actual,
        useRef: () => nullRef,
    };
});

import { NumberInput } from './NumberInput';

describe('NumberInput ref guard', () => {
    it('does nothing when the internal input ref is unavailable', () => {
        const onChange = vi.fn();
        render(<NumberInput value={5} step={1} onChange={onChange} />);

        fireEvent.mouseDown(screen.getByTestId('chevron-up').parentElement!);
        fireEvent.mouseDown(screen.getByTestId('chevron-down').parentElement!);

        expect(onChange).not.toHaveBeenCalled();
    });
});
