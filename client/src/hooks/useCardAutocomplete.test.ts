import { renderHook, act } from '@testing-library/react';
import { useCardAutocomplete } from './useCardAutocomplete';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('useCardAutocomplete', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize with default values', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));
        expect(result.current.query).toBe('');
        expect(result.current.hoveredIndex).toBeNull();
    });

    it('should update query on input change', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            result.current.handleInputChange({ target: { value: 'Sol' } } as React.ChangeEvent<HTMLInputElement>);
        });

        expect(result.current.query).toBe('Sol');
        expect(result.current.hoveredIndex).toBeNull();
    });

    it('should handle clear', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            result.current.handleInputChange({ target: { value: 'Sol' } } as React.ChangeEvent<HTMLInputElement>);
            result.current.handleClear();
        });

        expect(result.current.query).toBe('');
        expect(result.current.hoveredIndex).toBeNull();
    });

    describe('keyboard navigation', () => {
    it('should navigate down with ArrowDown', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

            act(() => {
                const handler = result.current.createKeyDownHandler(5);
                handler({ key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
            });

        expect(result.current.hoveredIndex).toBe(0);
    });

    it('should return null for ArrowDown when there are no items', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            const handler = result.current.createKeyDownHandler(0);
            handler({ key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
        });

        expect(result.current.hoveredIndex).toBeNull();
    });

    it('should clamp ArrowDown at the last item', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            result.current.setHoveredIndex(4);
        });

        act(() => {
            const handler = result.current.createKeyDownHandler(5);
            handler({ key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
        });

        expect(result.current.hoveredIndex).toBe(4);
    });

    it('should navigate up with ArrowUp', () => {
      const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

            // Start from index 2
            act(() => {
                result.current.setHoveredIndex(2);
            });

            act(() => {
                const handler = result.current.createKeyDownHandler(5);
                handler({ key: 'ArrowUp', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
            });

      expect(result.current.hoveredIndex).toBe(1);
    });

    it('should clamp ArrowUp to the last item when none is hovered', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            const handler = result.current.createKeyDownHandler(5);
            handler({ key: 'ArrowUp', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
        });

        expect(result.current.hoveredIndex).toBe(4);
    });

    it('should return null for ArrowUp when there are no items', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        act(() => {
            const handler = result.current.createKeyDownHandler(0);
            handler({ key: 'ArrowUp', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
        });

        expect(result.current.hoveredIndex).toBeNull();
    });

    it('should call onSelect on Enter with query', () => {
      const onSelect = vi.fn();
            const { result } = renderHook(() => useCardAutocomplete({ onSelect }));

            act(() => {
                result.current.handleInputChange({ target: { value: 'Sol Ring' } } as React.ChangeEvent<HTMLInputElement>);
            });

            act(() => {
                const handler = result.current.createKeyDownHandler(0);
                handler({ key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent);
            });

            expect(onSelect).toHaveBeenCalledWith('Sol Ring');
        });

    it('should not call onSelect on Enter with empty query', () => {
        const onSelect = vi.fn();
        const { result } = renderHook(() => useCardAutocomplete({ onSelect }));

            act(() => {
                const handler = result.current.createKeyDownHandler(0);
                handler({ key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent);
            });

        expect(onSelect).not.toHaveBeenCalled();
    });

    it('should ignore unrelated keys', () => {
        const onSelect = vi.fn();
        const { result } = renderHook(() => useCardAutocomplete({ onSelect }));

        act(() => {
            const handler = result.current.createKeyDownHandler(3);
            handler({ key: 'Tab', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent);
        });

        expect(result.current.hoveredIndex).toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('should delegate handleKeyDown to the zero-item keydown handler', () => {
        const onSelect = vi.fn();
        const { result } = renderHook(() => useCardAutocomplete({ onSelect }));

        act(() => {
            result.current.handleInputChange({ target: { value: '  Sol Ring  ' } } as React.ChangeEvent<HTMLInputElement>);
        });

        act(() => {
            result.current.handleKeyDown({
                key: 'Enter',
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            } as unknown as React.KeyboardEvent);
        });

        expect(onSelect).toHaveBeenCalledWith('Sol Ring');
    });

    it('should reset hoveredIndex on Escape', () => {
      const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

            act(() => {
                result.current.setHoveredIndex(2);
            });

            act(() => {
                const handler = result.current.createKeyDownHandler(5);
                handler({ key: 'Escape' } as React.KeyboardEvent);
            });

      expect(result.current.hoveredIndex).toBeNull();
    });

    it('should clear hoveredIndex on outside click and remove the listener on unmount', () => {
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const { result, unmount } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        const root = document.createElement('div');
        const inside = document.createElement('button');
        root.appendChild(inside);
        document.body.appendChild(root);
        result.current.containerRef.current = root as HTMLDivElement;

        act(() => {
            result.current.setHoveredIndex(2);
        });

        act(() => {
            document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(result.current.hoveredIndex).toBeNull();

        unmount();

        expect(addSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        document.body.removeChild(root);
    });

    it('should not clear hoveredIndex when clicking inside the container', () => {
        const { result } = renderHook(() => useCardAutocomplete({ onSelect: vi.fn() }));

        const root = document.createElement('div');
        const inside = document.createElement('button');
        root.appendChild(inside);
        document.body.appendChild(root);
        result.current.containerRef.current = root as HTMLDivElement;

        act(() => {
            result.current.setHoveredIndex(2);
        });

        act(() => {
            inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(result.current.hoveredIndex).toBe(2);
        document.body.removeChild(root);
    });
  });
});
