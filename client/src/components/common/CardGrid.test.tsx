import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CardGrid } from './CardGrid';

describe('CardGrid', () => {
    it('preserves the card-size column width alongside caller styles', () => {
        const ref = createRef<HTMLDivElement>();
        const { rerender } = render(
            <CardGrid ref={ref} data-testid="grid" cardSize={2} style={{ backgroundColor: 'red' }}>
                Card art
            </CardGrid>
        );

        const grid = screen.getByTestId('grid');
        expect(grid.style.getPropertyValue('--card-grid-col-width')).toBe('550px');
        expect(grid.style.backgroundColor).toBe('red');
        expect(ref.current).toBe(grid);
        expect(grid.textContent).toBe('Card art');

        rerender(
            <CardGrid data-testid="grid" cardSize={1} style={{ backgroundColor: 'blue' }}>
                Card art
            </CardGrid>
        );
        expect(grid.style.getPropertyValue('--card-grid-col-width')).toBe('275px');
        expect(grid.style.backgroundColor).toBe('blue');
    });
});
