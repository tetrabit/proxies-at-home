import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

describe('ColorPicker EyeDropper support', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the EyeDropper when available and commits the selected color', async () => {
    class MockEyeDropper {
      open = vi.fn().mockResolvedValue({ sRGBHex: '#123456' });
    }

    vi.stubGlobal('EyeDropper', MockEyeDropper);

    const { ColorPicker } = await import('./ColorPicker');
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();

    const { container } = render(
      <ColorPicker label="Pick" value="#abcdef" onChange={onChange} onChangeEnd={onChangeEnd} />,
    );

    fireEvent.click(container.querySelector('button[title="Click to pick color"]')!);
    fireEvent.click(screen.getByTitle('Pick color from screen'));

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#123456'));
    expect(onChangeEnd).toHaveBeenCalledWith('#123456', '#abcdef');
  });
});
