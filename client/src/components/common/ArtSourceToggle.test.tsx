import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtSourceToggle } from './ArtSourceToggle';

describe('ArtSourceToggle', () => {
  it('renders Scryfall before MPC by default and forwards changes', () => {
    const onChange = vi.fn();
    render(<ArtSourceToggle value="scryfall" onChange={onChange} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Scryfall', 'MPC Autofill']);

    fireEvent.pointerUp(screen.getByText('MPC Autofill')); 
    expect(onChange).toHaveBeenCalledWith('mpc');
  });

  it('reverses option order for vertical layouts and keeps extra props', () => {
    render(
      <ArtSourceToggle
        value="mpc"
        onChange={vi.fn()}
        reversed
        aria-label="Preferred source"
      />
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['MPC Autofill', 'Scryfall']);
  });
});
