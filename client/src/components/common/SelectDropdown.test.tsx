import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SelectDropdown } from './SelectDropdown';

describe('SelectDropdown', () => {
    const defaultProps = {
        buttonText: 'Any',
        isOpen: false,
        onToggle: vi.fn(),
        onClose: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('should render with buttonText', () => {
        render(
            <SelectDropdown {...defaultProps}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.getByText('Any')).toBeDefined();
    });

    it('should render label when provided', () => {
        render(
            <SelectDropdown {...defaultProps} label="Test Label">
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.getByText('Test Label')).toBeDefined();
    });

    it('should call onToggle when button is clicked', () => {
        const onToggle = vi.fn();
        render(
            <SelectDropdown {...defaultProps} onToggle={onToggle}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        const button = screen.getByRole('button', { name: /Any/i });
        fireEvent.click(button);

        expect(onToggle).toHaveBeenCalled();
    });

    it('should render children when open', () => {
        render(
            <SelectDropdown {...defaultProps} isOpen={true}>
                <button>Option 1</button>
                <button>Option 2</button>
            </SelectDropdown>
        );

        expect(screen.getByText('Option 1')).toBeDefined();
        expect(screen.getByText('Option 2')).toBeDefined();
    });

    it('should show selectedLabel in singleSelectMode', () => {
        render(
            <SelectDropdown
                {...defaultProps}
                singleSelectMode
                selectedLabel="Selected Option"
            >
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.getByText('Selected Option')).toBeDefined();
    });

    it('should show selectedCount with check icon in multi-select mode', () => {
        render(
            <SelectDropdown {...defaultProps} selectedCount={3}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.getByText('3')).toBeDefined();
    });

    it('should close dropdown when clicking outside', () => {
        const onClose = vi.fn();
        render(
            <div>
                <div data-testid="outside">Outside</div>
                <SelectDropdown {...defaultProps} isOpen={true} onClose={onClose}>
                    <button>Option 1</button>
                </SelectDropdown>
            </div>
        );

        fireEvent.mouseDown(screen.getByTestId('outside'));

        expect(onClose).toHaveBeenCalled();
    });

    it('should render favorites star button when favorites provided', () => {
        const favorites = {
            values: ['fav1', 'fav2'],
            isSelected: () => false,
            onToggle: vi.fn(),
        };

        render(
            <SelectDropdown {...defaultProps} favorites={favorites}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.getByTitle('Select favorites')).toBeDefined();
    });

    it('should open the portal at the measured button position', async () => {
        const favorites = {
            values: ['fav1'],
            isSelected: () => false,
            onToggle: vi.fn(),
        };
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            bottom: 20,
            left: 10,
            width: 100,
            top: 0,
            right: 0,
            x: 0,
            y: 0,
            height: 20,
            toJSON: () => ({}),
        } as DOMRect);
        render(
            <SelectDropdown {...defaultProps} isOpen={true} favorites={favorites}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        await waitFor(() => {
            const panel = document.body.querySelector('[class*="fixed z-100000"]') as HTMLElement | null;
            expect(panel).not.toBeNull();
            expect(panel?.style.top).toBe('24px');
            expect(panel?.style.left).toBe('10px');
            expect(panel?.style.minWidth).toBe('100px');
        });
    });

    it('should toggle only missing favorites in multi-select mode', () => {
        const onToggle = vi.fn();
        const selected = new Set(['fav1']);
        const favorites = {
            values: ['fav1', 'fav2'],
            isSelected: (value: string | number) => selected.has(String(value)),
            onToggle,
        };

        render(
            <SelectDropdown {...defaultProps} favorites={favorites}>
                <button>Option 1</button>
            </SelectDropdown>
        );

        fireEvent.click(screen.getByTitle('Select favorites'));
        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(onToggle).toHaveBeenCalledWith('fav2');
    });

    it('should toggle the first favorite in single-select mode and deselect an active favorite', () => {
        const onToggle = vi.fn();
        const selected = new Set<string>();
        const favorites = {
            values: ['fav1', 'fav2'],
            isSelected: (value: string | number) => selected.has(String(value)),
            onToggle: (value: string | number) => {
                onToggle(value);
                if (selected.has(String(value))) {
                    selected.delete(String(value));
                } else {
                    selected.clear();
                    selected.add(String(value));
                }
            },
        };

        const { rerender } = render(
            <SelectDropdown {...defaultProps} favorites={favorites} singleSelectMode>
                <button>Option 1</button>
            </SelectDropdown>
        );

        fireEvent.click(screen.getByTitle('Select favorite'));
        expect(onToggle).toHaveBeenCalledWith('fav1');

        rerender(
            <SelectDropdown {...defaultProps} favorites={favorites} singleSelectMode>
                <button>Option 1</button>
            </SelectDropdown>
        );
        fireEvent.click(screen.getByTitle('Deselect favorite'));
        expect(onToggle).toHaveBeenLastCalledWith('fav1');
    });

    it('should not render favorites star when disableFavorites is true', () => {
        const favorites = {
            values: ['fav1', 'fav2'],
            isSelected: () => false,
            onToggle: vi.fn(),
        };

        render(
            <SelectDropdown {...defaultProps} favorites={favorites} disableFavorites>
                <button>Option 1</button>
            </SelectDropdown>
        );

        expect(screen.queryByTitle('Select favorites')).toBeNull();
    });
});
