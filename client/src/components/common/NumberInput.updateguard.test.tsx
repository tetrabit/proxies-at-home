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

    const mutableRef = <T,>(initial: T) => ({ current: initial });

    return {
        ...actual,
        useRef: (() => {
            let call = 0;
            return () => {
                call += 1;
                switch (call) {
                    case 1:
                        return nullRef;
                    case 2:
                        return mutableRef<NodeJS.Timeout | null>(null);
                    case 3:
                        return mutableRef<NodeJS.Timeout | null>(null);
                    case 4:
                        return mutableRef(false);
                    default:
                        return mutableRef(false);
                }
            };
        })(),
    };
});

import { NumberInput } from './NumberInput';

describe('NumberInput update guard', () => {
    it('does nothing when the inner input ref is unavailable before value updates', () => {
        const onChange = vi.fn();
        render(<NumberInput value={5} step={1} onChange={onChange} />);

        fireEvent.mouseDown(screen.getByTestId('chevron-up').parentElement!);

        expect(onChange).not.toHaveBeenCalled();
    });
});
