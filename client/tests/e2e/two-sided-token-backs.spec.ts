import { test, expect } from './fixtures';

type StoredCard = {
  uuid: string;
  name: string;
  order: number;
  isUserUpload: boolean;
  projectId: string;
  imageId?: string;
  linkedFrontId?: string;
  linkedBackId?: string;
  isToken?: boolean;
  scryfall_id?: string;
  tokenAddedFrom?: string[];
  usesDefaultCardback?: boolean;
};

test.describe('Two-sided associated tokens', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit is flaky in this environment');

    await page.route('**/api/cards/images/tokens', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('repairs default token backs into shuffled token backs', async ({ page }) => {
    await seedExistingTokenProject(page);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Add two sided associated tokens' }).click();

    await expect
      .poll(async () => getTokenBackSummary(page), {
        timeout: 10_000,
      })
      .toEqual([
        {
          front: 'soldier-front',
          backName: 'Treasure',
          backImageId: 'treasure-img',
          usesDefaultCardback: false,
        },
        {
          front: 'treasure-front',
          backName: 'Soldier',
          backImageId: 'soldier-img',
          usesDefaultCardback: false,
        },
      ]);
  });
});

async function seedExistingTokenProject(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function txDone(tx: IDBTransaction): Promise<void> {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    async function openDb(): Promise<IDBDatabase> {
      return await requestToPromise(indexedDB.open('ProxxiedDB'));
    }

    async function getCurrentProjectId(db: IDBDatabase): Promise<string> {
      const tx = db.transaction(['projects', 'userPreferences'], 'readonly');
      const prefs = await requestToPromise<{ lastProjectId?: string } | undefined>(
        tx.objectStore('userPreferences').get('default')
      );
      const projects = await requestToPromise<Array<{ id: string }>>(
        tx.objectStore('projects').getAll()
      );
      return prefs?.lastProjectId || projects[0]?.id || crypto.randomUUID();
    }

    const db = await openDb();
    const projectId = await getCurrentProjectId(db);

    const tx = db.transaction(['cards', 'images', 'projects', 'userPreferences'], 'readwrite');
    const cards = tx.objectStore('cards');
    const images = tx.objectStore('images');
    const projects = tx.objectStore('projects');
    const userPreferences = tx.objectStore('userPreferences');

    await requestToPromise(cards.clear());
    await requestToPromise(images.clear());

    await requestToPromise(projects.put({
      id: projectId,
      name: 'Two Sided Tokens',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      cardCount: 5,
      settings: {},
    }));
    await requestToPromise(userPreferences.put({
      id: 'default',
      settings: {},
      favoriteCardbacks: [],
      lastProjectId: projectId,
    }));

    await requestToPromise(images.put({
      id: 'treasure-img',
      refCount: 1,
      sourceUrl: 'https://example.test/treasure.png',
      imageUrls: ['https://example.test/treasure.png'],
      source: 'scryfall',
    }));
    await requestToPromise(images.put({
      id: 'soldier-img',
      refCount: 1,
      sourceUrl: 'https://example.test/soldier.png',
      imageUrls: ['https://example.test/soldier.png'],
      source: 'scryfall',
    }));

    const rows = [
      {
        uuid: 'source',
        name: 'Token Maker',
        order: 10,
        isUserUpload: false,
        projectId,
      },
      {
        uuid: 'treasure-front',
        name: 'Treasure',
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: 'treasure-img',
        scryfall_id: 'token-treasure',
        linkedBackId: 'treasure-back',
        tokenAddedFrom: ['Token Maker'],
        projectId,
      },
      {
        uuid: 'treasure-back',
        name: 'Rose',
        order: 20,
        isUserUpload: false,
        imageId: 'cardback_builtin_mtg',
        linkedFrontId: 'treasure-front',
        usesDefaultCardback: true,
        projectId,
      },
      {
        uuid: 'soldier-front',
        name: 'Soldier',
        order: 30,
        isUserUpload: false,
        isToken: true,
        imageId: 'soldier-img',
        scryfall_id: 'token-soldier',
        linkedBackId: 'soldier-back',
        tokenAddedFrom: ['Token Maker'],
        projectId,
      },
      {
        uuid: 'soldier-back',
        name: 'Rose',
        order: 30,
        isUserUpload: false,
        imageId: 'cardback_builtin_mtg',
        linkedFrontId: 'soldier-front',
        usesDefaultCardback: true,
        projectId,
      },
    ];

    for (const row of rows) {
      await requestToPromise(cards.put(row));
    }

    await txDone(tx);
    db.close();
  });
}

async function getTokenBackSummary(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
    function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async function openDb(): Promise<IDBDatabase> {
      return await requestToPromise(indexedDB.open('ProxxiedDB'));
    }

    const db = await openDb();
    const tx = db.transaction(['cards'], 'readonly');
    const cards = await requestToPromise(tx.objectStore('cards').getAll()) as StoredCard[];
    db.close();

    const cardsByUuid = new Map(cards.map((card) => [card.uuid, card]));
    return cards
      .filter((card) => card.isToken && !card.linkedFrontId)
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((front) => {
        const back = front.linkedBackId ? cardsByUuid.get(front.linkedBackId) : undefined;
        return {
          front: front.uuid,
          backName: back?.name,
          backImageId: back?.imageId,
          usesDefaultCardback: back?.usesDefaultCardback,
        };
      });
  });
}
