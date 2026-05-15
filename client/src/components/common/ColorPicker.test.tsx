import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-colorful', () => ({
  HexColorPicker: ({ color, onChange }: { color: string; onChange: (color: string) => void }) => (
    <button data-testid="hex-color-picker" data-color={color} onClick={() => onChange('#abcdef')}>picker</button>
  ),
}));

vi.mock('@floating-ui/react', () => ({
  useFloating: () => ({
    refs: {
      setReference: vi.fn(),
      setFloating: vi.fn(),
      floating: { current: null },
      reference: { current: null },
    },
    floatingStyles: { position: 'absolute' },
  }),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn(),
}));

import { ColorPicker } from './ColorPicker';

describe('ColorPicker', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders label, swatch, and commits text changes on blur', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(<ColorPicker label="Guide Color" value="#112233" onChange={onChange} onChangeEnd={onChangeEnd} />);

    expect(screen.getByText('Guide Color')).toBeDefined();
    const textInput = screen.getByPlaceholderText('#000000');
    fireEvent.focus(textInput);
    fireEvent.change(textInput, { target: { value: '#445566' } });
    expect(onChange).toHaveBeenCalledWith('#445566');

    render(<ColorPicker label="Guide Color" value="#445566" onChange={onChange} onChangeEnd={onChangeEnd} />);
    fireEvent.focus(screen.getAllByPlaceholderText('#000000').at(-1)!);
    fireEvent.blur(screen.getAllByPlaceholderText('#000000').at(-1)!);
    expect(onChangeEnd).not.toHaveBeenCalled();
  });

  it('opens the popover, changes picker/RGB/HSL values, toggles mode, and closes on scroll', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container, rerender } = render(<ColorPicker label="Pick" value="#336699" onChange={onChange} onChangeEnd={onChangeEnd} />);

    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);
    fireEvent.click(screen.getByTestId('hex-color-picker'));
    expect(onChange).toHaveBeenCalledWith('#abcdef');

    const rgbInputs = screen.getAllByDisplayValue(/^(51|102|153)$/);
    fireEvent.keyDown(rgbInputs[0], { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('#346699');
    fireEvent.keyDown(rgbInputs[1], { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('#336599');

    fireEvent.click(screen.getByTitle('Toggle RGB/HSL'));
    expect(screen.getByText('HSL')).toBeDefined();
    const hslInputs = screen.getAllByDisplayValue(/^(210|50|40)$/);
    fireEvent.change(hslInputs[2], { target: { value: '50' } });
    expect(onChange).toHaveBeenCalled();

    rerender(<ColorPicker label="Pick" value="#abcdef" onChange={onChange} onChangeEnd={onChangeEnd} />);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(onChangeEnd).toHaveBeenCalledWith('#abcdef', '#336699');
  });

  it('clamps RGB spin inputs when eyedropper is unavailable', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container } = render(<ColorPicker label="Pick" value="#000000" onChange={onChange} onChangeEnd={onChangeEnd} />);

    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);
    expect(screen.queryByTitle('Pick color from screen')).toBeNull();

    const inputs = screen.getAllByDisplayValue('0');
    fireEvent.change(inputs[0], { target: { value: '999' } });
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');
    fireEvent.change(inputs[1], { target: { value: '-5' } });
    expect(onChange).toHaveBeenLastCalledWith('#000000');
  });

});
