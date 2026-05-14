import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CardImageSvg } from './CardImageSvg';

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  intersect(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe('CardImageSvg', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lazy-loads the image once visible and marks it loaded', () => {
    const { container } = render(<CardImageSvg id="card-1" url="front.png" />);
    const svg = screen.getByRole('img', { name: 'Card image for card-1' });

    expect(container.querySelector('image')).toBeNull();
    act(() => MockIntersectionObserver.instances[0].intersect(svg));

    const image = container.querySelector('image')!;
    expect(image.getAttribute('href')).toBe('front.png');
    expect(image.getAttribute('clip-path') ?? image.getAttribute('clipPath')).toBe('url(#clip-card-1)');

    fireEvent.load(image);
    expect((image as SVGImageElement).style.opacity).toBe('1');
  });

  it('uses bleed dimensions, skips rounding, and switches to fallback once', () => {
    const { container } = render(
      <CardImageSvg
        id="bleed-card"
        url="front.png"
        fallbackUrl="fallback.png"
        rounded={false}
        bleed={{ amountMm: 3, sourceWidthMm: 69, sourceHeightMm: 94 }}
      />
    );
    const svg = screen.getByRole('img', { name: 'Card image for bleed-card' });
    expect(svg.getAttribute('viewBox')).toBe('3 3 63 88');
    expect(container.querySelector('clipPath')).toBeNull();

    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    const image = container.querySelector('image')!;
    expect(image.getAttribute('width')).toBe('69');
    expect(image.getAttribute('height')).toBe('94');
    expect(image.getAttribute('clip-path') ?? image.getAttribute('clipPath')).toBeNull();

    fireEvent.error(image);
    expect(container.querySelector('image')!.getAttribute('href')).toBe('fallback.png');
    fireEvent.error(container.querySelector('image')!);
    expect(container.querySelector('image')!.getAttribute('href')).toBe('fallback.png');
  });

  it('resets load state when the URL changes', () => {
    const { container, rerender } = render(<CardImageSvg id="card-2" url="one.png" />);
    const svg = screen.getByRole('img', { name: 'Card image for card-2' });
    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    fireEvent.load(container.querySelector('image')!);

    rerender(<CardImageSvg id="card-2" url="two.png" />);

    expect(container.querySelector('rect')).toBeTruthy();
    act(() => MockIntersectionObserver.instances.at(-1)!.intersect(svg));
    expect(container.querySelector('image')!.getAttribute('href')).toBe('two.png');
  });
});
