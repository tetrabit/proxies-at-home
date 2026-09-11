import { test, expect } from '@playwright/test';
import type { MoxfieldDeck, MoxfieldDeckCard } from '../../src/helpers/moxfieldApi';

// Controlled provider responses: this tests the UI through the actual extractor
// and import request, not Moxfield availability or Scryfall/image retrieval.
function deckCard(name: string, boardType: string, quantity: number): MoxfieldDeckCard {
  return {
    boardType, quantity, finish: 'nonFoil', isFoil: false,
    card: {
      id: name, uniqueCardId: name, scryfall_id: name, name,
      set: 'TST', set_name: 'Fixture', cn: '1', layout: 'normal', type_line: 'Artifact',
    },
  };
}

const deck: MoxfieldDeck = {
  id: 'considering-fixture', publicId: 'considering-fixture',
  publicUrl: 'https://moxfield.com/decks/considering-fixture',
  name: 'Considering fixture', format: 'commander',
  mainboard: { main: deckCard('Sol Ring', 'mainboard', 1) },
  maybeboard: { maybe: deckCard('Arcane Signet', 'maybeboard', 3) },
  sideboard: {}, commanders: {}, companions: {},
  mainboardCount: 1, maybeboardCount: 3, sideboardCount: 0, commandersCount: 0, companionsCount: 0,
};

test.use({ serviceWorkers: 'block' });

for (const mode of ['default', 'checked', 'unchecked again'] as const) {
  test(`Considering cards: ${mode}`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const requests: { cardQueries: { name: string }[] }[] = [];
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/moxfield/decks/considering-fixture') {
        await route.fulfill({ json: deck });
      } else if (pathname === '/api/stream/cards') {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'text/event-stream', body: 'event: done\ndata: {}\n\n' });
      } else {
        await route.fulfill({ json: {} });
      }
    });
    await page.goto('/');
    const input = page.getByPlaceholder('Paste Archidekt or Moxfield deck URL...').locator('visible=true');
    await input.fill(deck.publicUrl);
    const checkbox = page.getByRole('checkbox', { name: 'Include considering cards (Moxfield)' });
    await expect(checkbox).not.toBeChecked();
    if (mode !== 'default') await checkbox.check();
    if (mode === 'unchecked again') await checkbox.uncheck();
    await checkbox.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('import-options.png'), fullPage: true });
    await page.getByRole('button', { name: 'Import Deck', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].cardQueries.map(card => card.name)).toEqual(
      mode === 'checked' ? ['Sol Ring', 'Arcane Signet'] : ['Sol Ring'],
    );
    expect(pageErrors).toEqual([]);
  });
}
