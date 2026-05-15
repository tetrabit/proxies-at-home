import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import { CardImageSvg } from './CardImageSvg';

describe('CardImageSvg ref guard', () => {
  it('skips observing when the svg ref is unavailable', () => {
    const { container } = render(<CardImageSvg id="missing-ref" url="front.png" />);

    expect(screen.getByRole('img', { name: 'Card image for missing-ref' })).toBeDefined();
    expect(container.querySelector('image')).toBeNull();
  });
});
