import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-colorful', () => ({
  HexColorPicker: ({ color, onChange }: { color: string; onChange: (color: string) => void }) => (
    <button data-testid="hex-color-picker" data-color={color} onClick={() => onChange('#abcdef')}>picker</button>
  ),
}));

const floatingState = vi.hoisted(() => ({
  floating: { current: null as HTMLElement | null },
  reference: { current: null as HTMLElement | null },
}));

vi.mock('@floating-ui/react', () => ({
  useFloating: () => ({
    refs: {
      setReference: (node: HTMLElement | null) => { floatingState.reference.current = node; },
      setFloating: (node: HTMLElement | null) => { floatingState.floating.current = node; },
      floating: floatingState.floating,
      reference: floatingState.reference,
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
    floatingState.floating.current = null;
    floatingState.reference.current = null;
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
    const { rerender } = render(
      <ColorPicker label="Guide Color" value="#112233" onChange={onChange} onChangeEnd={onChangeEnd} />
    );

    expect(screen.getByText('Guide Color')).toBeDefined();
    let textInput = screen.getByPlaceholderText('#000000');
    fireEvent.focus(textInput);
    fireEvent.change(textInput, { target: { value: '#445566' } });
    expect(onChange).toHaveBeenCalledWith('#445566');

    rerender(<ColorPicker label="Guide Color" value="#445566" onChange={onChange} onChangeEnd={onChangeEnd} />);
    textInput = screen.getByPlaceholderText('#000000');
    fireEvent.blur(textInput);
    expect(onChangeEnd).toHaveBeenCalledWith('#445566', '#112233');

    fireEvent.focus(textInput);
    fireEvent.blur(textInput);
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
  });

  it('opens the popover, changes picker/RGB/HSL values, toggles mode, and closes on scroll', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container, rerender } = render(<ColorPicker label="Pick" value="#336699" onChange={onChange} onChangeEnd={onChangeEnd} />);

    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);
    fireEvent.click(screen.getByTestId('hex-color-picker'));
    expect(onChange).toHaveBeenCalledWith('#abcdef');
    fireEvent.change(screen.getAllByPlaceholderText('#000000').at(-1)!, { target: { value: '#fedcba' } });
    expect(onChange).toHaveBeenCalledWith('#fedcba');

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

  it('closes an unchanged popover from the swatch without committing', () => {
    const onChangeEnd = vi.fn();
    const { container } = render(
      <ColorPicker label="Pick" value="#111111" onChange={vi.fn()} onChangeEnd={onChangeEnd} />
    );
    const swatch = container.querySelector('button[title="Click to pick color"]')!;

    fireEvent.click(swatch);
    expect(screen.getByTestId('hex-color-picker')).toBeDefined();
    fireEvent.click(swatch);

    expect(screen.queryByTestId('hex-color-picker')).toBeNull();
    expect(onChangeEnd).not.toHaveBeenCalled();
  });

  it('ignores inside clicks and commits changed colors on outside clicks', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container, rerender } = render(
      <ColorPicker label="Pick" value="#111111" onChange={onChange} onChangeEnd={onChangeEnd} />
    );

    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);
    fireEvent.mouseDown(screen.getByTestId('hex-color-picker'));
    expect(onChangeEnd).not.toHaveBeenCalled();

    rerender(<ColorPicker label="Pick" value="#222222" onChange={onChange} onChangeEnd={onChangeEnd} />);
    fireEvent.mouseDown(document.body);
    expect(onChangeEnd).toHaveBeenCalledWith('#222222', '#111111');
  });

  it('covers spin buttons, keyboard fallbacks, invalid hex, and HSL conversion ranges', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ColorPicker label="Pick" value="invalid" onChange={onChange} />
    );
    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);

    const rgbInputs = screen.getAllByDisplayValue('0');
    fireEvent.keyDown(rgbInputs[0], { key: 'Enter' });
    fireEvent.change(rgbInputs[0], { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('#000000');
    fireEvent.change(rgbInputs[2], { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith('#00000a');
    const spinButtons = Array.from(document.querySelectorAll('button[tabindex="-1"]'));
    fireEvent.click(spinButtons[0]);
    expect(onChange).toHaveBeenCalledWith('#010000');
    fireEvent.click(spinButtons[1]);
    expect(onChange).toHaveBeenCalledWith('#000000');

    rerender(<ColorPicker label="Pick" value="#ff0000" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Toggle RGB/HSL'));
    let hslInputs = screen.getAllByDisplayValue(/^(0|100|50)$/);
    fireEvent.change(hslInputs[1], { target: { value: '50' } });
    expect(onChange).toHaveBeenLastCalledWith('#bf4040');
    fireEvent.change(hslInputs[0], { target: { value: '360' } });
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');
    fireEvent.change(hslInputs[2], { target: { value: '25' } });
    expect(onChange).toHaveBeenLastCalledWith('#800000');
    fireEvent.change(hslInputs[0], { target: { value: '120' } });
    expect(onChange).toHaveBeenLastCalledWith('#00ff00');

    rerender(<ColorPicker label="Pick" value="#ff00ff" onChange={onChange} />);
    expect(screen.getByDisplayValue('300')).toBeDefined();

    rerender(<ColorPicker label="Pick" value="#00ff00" onChange={onChange} />);
    hslInputs = screen.getAllByDisplayValue(/^(120|100|50)$/);
    fireEvent.change(hslInputs[0], { target: { value: '240' } });
    expect(onChange).toHaveBeenLastCalledWith('#0000ff');

    rerender(<ColorPicker label="Pick" value="#808080" onChange={onChange} />);
    hslInputs = screen.getAllByDisplayValue(/^(0|50)$/);
    fireEvent.change(hslInputs.at(-1)!, { target: { value: '60' } });
    expect(onChange).toHaveBeenLastCalledWith('#999999');
    fireEvent.click(screen.getByTitle('Toggle RGB/HSL'));
    expect(screen.getByText('RGB')).toBeDefined();
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
