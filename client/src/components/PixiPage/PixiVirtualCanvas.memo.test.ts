import { describe, expect, it } from "vitest";
import { arePixiVirtualCanvasPropsEqual, type CardWithGlobalLayout } from "./PixiVirtualCanvas";
import type { CardOption } from "../../../../shared/types";

const baseCard: CardOption = {
  uuid: "card-1",
  name: "Card 1",
  order: 10,
  isUserUpload: false,
  imageId: "front-1",
};

function layout(overrides: Partial<CardWithGlobalLayout> = {}): CardWithGlobalLayout {
  return {
    card: baseCard,
    imageBlob: new Blob(["front"]),
    backBlob: new Blob(["back"]),
    frontImageId: "front-1",
    backImageId: "back-1",
    darknessFactor: 0.5,
    globalX: 1,
    globalY: 2,
    width: 63,
    height: 88,
    bleedMm: 1,
    baseCardWidthMm: 63,
    baseCardHeightMm: 88,
    overridesHash: "front",
    backOverridesHash: "back",
    ...overrides,
  };
}

function props(overrides: Partial<Parameters<typeof arePixiVirtualCanvasPropsEqual>[0]> = {}): Parameters<typeof arePixiVirtualCanvasPropsEqual>[0] {
  return {
    cards: [layout()],
    pages: [{ pageIndex: 0, pageWidthPx: 100, pageHeightPx: 200, pageYOffset: 10 }],
    viewportWidth: 100,
    viewportHeight: 200,
    scrollTop: 0,
    zoom: 1,
    globalDarkenMode: "none",
    flippedCards: new Set(),
    activeId: null,
    guideWidth: 1,
    cutLineStyle: "full",
    perCardGuideStyle: "solid-rounded-rect",
    perCardGuideColor: 0xffffff,
    perCardGuidePlacement: "inside",
    showGuideLinesOnBackCards: false,
    cutGuideLengthMm: 3,
    registrationMarks: "4",
    registrationMarksPortrait: false,
    isDarkMode: false,
    ...overrides,
  };
}

describe("arePixiVirtualCanvasPropsEqual", () => {
  it("accepts identical shallow props and card hashes", () => {
    const sharedCards = [layout()];
    const sharedPages = [{ pageIndex: 0, pageWidthPx: 100, pageHeightPx: 200, pageYOffset: 10 }];
    const sharedFlips = new Set<string>();
    expect(
      arePixiVirtualCanvasPropsEqual(
        props({ cards: sharedCards, pages: sharedPages, flippedCards: sharedFlips }),
        props({ cards: sharedCards, pages: sharedPages, flippedCards: sharedFlips }),
      ),
    ).toBe(true);
  });

  it("rejects changed shallow props, card identity, layout fields, and override hashes", () => {
    const base = props();
    expect(arePixiVirtualCanvasPropsEqual(base, props({ viewportWidth: 101 }))).toBe(false);
    expect(arePixiVirtualCanvasPropsEqual(base, props({ cards: [] }))).toBe(false);
    expect(arePixiVirtualCanvasPropsEqual(base, props({ cards: [layout({ card: { ...baseCard, uuid: "other" } })] }))).toBe(false);
    expect(arePixiVirtualCanvasPropsEqual(base, props({ cards: [layout({ width: 64 })] }))).toBe(false);
    expect(arePixiVirtualCanvasPropsEqual(base, props({ cards: [layout({ overridesHash: "changed" })] }))).toBe(false);
    expect(arePixiVirtualCanvasPropsEqual(base, props({ cards: [layout({ backOverridesHash: "changed" })] }))).toBe(false);
  });
});
