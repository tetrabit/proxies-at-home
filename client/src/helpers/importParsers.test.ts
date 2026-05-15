import { describe, it, expect, vi } from 'vitest';
import { parseMpcXml, parseLineToIntent, createIntentFromPreloaded, parseDeckBuilderUrl, parseDeckList, hasIncompleteTagSyntax } from './importParsers';
import * as moxfieldApi from './moxfieldApi';
import * as archidektApi from './archidektApi';

describe('importParsers', () => {
    describe('parseLineToIntent', () => {
        it('parses standard line: "4x Sol Ring"', () => {
            const result = parseLineToIntent('4x Sol Ring');
            expect(result).toEqual(expect.objectContaining({
                name: 'Sol Ring',
                quantity: 4,
                isToken: false
            }));
        });

        it('parses set/number: "Sol Ring [LEA] {123}"', () => {
            const result = parseLineToIntent('Sol Ring [LEA] {123}');
            expect(result).toEqual(expect.objectContaining({
                name: 'Sol Ring',
                set: 'lea',
                number: '123'
            }));
        });

        it('parses token syntax: "t:Goblin"', () => {
            const result = parseLineToIntent('t:Goblin');
            expect(result).toEqual(expect.objectContaining({
                name: 'Goblin',
                isToken: true
            }));
        });

        it('parses MPC syntax: "Sol Ring [mpc:12345]"', () => {
            const result = parseLineToIntent('Sol Ring [mpc:12345]');
            expect(result).toEqual(expect.objectContaining({
                name: 'Sol Ring',
                mpcId: '12345',
                sourcePreference: 'mpc'
            }));
        });

        it('detects incomplete tag syntax only at the end of a query', () => {
            expect(hasIncompleteTagSyntax('set:')).toBe(true);
            expect(hasIncompleteTagSyntax('lightning set:')).toBe(true);
            expect(hasIncompleteTagSyntax('set:lea bolt')).toBe(false);
        });

        it('parses quoted and underscored token syntax', () => {
            expect(parseLineToIntent('t:"Human Soldier"')).toEqual(expect.objectContaining({
                name: 'Human Soldier',
                isToken: true,
            }));
            expect(parseLineToIntent("t:'Goblin'")).toEqual(expect.objectContaining({
                name: 'Goblin',
                isToken: true,
            }));
            expect(parseLineToIntent('t:human_soldier')).toEqual(expect.objectContaining({
                name: 'human soldier',
                isToken: true,
            }));
        });

        it('strips decorative tails and parses set/number suffix variants', () => {
            expect(parseLineToIntent('Sol Ring ^foil^ [Commander] ★')).toEqual(expect.objectContaining({
                name: 'Sol Ring',
            }));
            expect(parseLineToIntent('Lightning Bolt (lea) 161')).toEqual(expect.objectContaining({
                name: 'Lightning Bolt',
                set: 'lea',
                number: '161',
            }));
            expect(parseLineToIntent('Counterspell set:mh2 cn:42')).toEqual(expect.objectContaining({
                name: 'Counterspell',
                set: 'mh2',
                number: '42',
            }));
            expect(parseLineToIntent('Brainstorm [note] set:ice')).toEqual(expect.objectContaining({
                name: 'Brainstorm',
                set: 'ice',
            }));
            expect(parseLineToIntent('Ponder ^foil^ set:lrw')).toEqual(expect.objectContaining({
                name: 'Ponder',
                set: 'lrw',
            }));
            expect(parseLineToIntent('Opt [dom] {60} [note]')).toEqual(expect.objectContaining({
                name: 'Opt',
                set: 'dom',
                number: '60',
            }));
            expect(parseLineToIntent('Island {301}')).toEqual(expect.objectContaining({
                name: 'Island',
            }));
            expect(parseLineToIntent('Forest (abc)')).toEqual(expect.objectContaining({
                name: 'Forest',
                set: 'abc',
                number: undefined,
            }));
        });
    });

    describe('parseMpcXml', () => {
        it('parses valid MPC XML string', () => {
            const xml = `
    <order>
    <fronts>
    <card>
    <id>drive_front_123</id>
    <name>Sol Ring</name>
        <slots>0</slots>
        </card>
        </fronts>
        <backs>
        <card>
        <id>drive_back_456</id>
        <name>Custom Back</name>
            <slots>0</slots>
            </card>
            </backs>
            </order>
                `;
            const intents = parseMpcXml(xml);
            expect(intents).toHaveLength(1);
            expect(intents[0]).toEqual(expect.objectContaining({
                name: 'Sol Ring',
                quantity: 1,
                mpcId: 'drive_front_123',
                linkedBackImageId: 'drive_back_456',
                sourcePreference: 'mpc'
            }));
        });

        it('ignores global cardback (handled by app defaults)', () => {
            const xml = `
            <order>
            <cardback>drive_global_back</cardback>
            <fronts>
            <card>
            <id>drive_front_1</id>
            <name>Card A</name>
                <slots>0</slots>
                </card>
                </fronts>
                <backs> </backs>
                </order>
                    `;
            const intents = parseMpcXml(xml);
            // Global cardbacks should NOT create DFC links
            expect(intents[0].linkedBackImageId).toBeUndefined();
        });

        it('rejects invalid or missing MPC XML orders', () => {
            expect(() => parseMpcXml('<order>')).toThrow('Failed to parse MPC XML');
            expect(() => parseMpcXml('<root />')).toThrow('Missing <order>');
        });

        it('uses filename names, query fallback, and warns when front slots use different backs', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const xml = `
              <order>
                <fronts>
                  <card>
                    <id>drive_front_123</id>
                    <name>Fancy_Card.png</name>
                    <query>Ignored Query</query>
                    <slots>0,1</slots>
                  </card>
                  <card>
                    <id></id>
                    <name></name>
                    <query>Query Fallback</query>
                    <slots></slots>
                  </card>
                </fronts>
                <backs>
                  <card><id>drive_back_a</id><name>Back_A.png</name><slots>0</slots></card>
                  <card><id>drive_back_b</id><name></name><slots>1</slots></card>
                </backs>
              </order>`;

            const intents = parseMpcXml(xml);

            expect(intents[0]).toEqual(expect.objectContaining({
                name: 'Fancy Card',
                filename: 'Fancy_Card.png',
                mpcId: 'drive_front_123',
                linkedBackImageId: 'drive_back_a',
                linkedBackName: 'Back A',
                quantity: 2,
            }));
            expect(intents[1]).toEqual(expect.objectContaining({
                name: 'Query Fallback',
                quantity: 1,
                mpcId: undefined,
            }));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different backs per slot'));
            warnSpy.mockRestore();
        });

        it('handles missing MPC XML ids, slots, and card names defensively', () => {
            const xml = `
              <order>
                <fronts>
                  <card>
                    <id></id>
                    <name></name>
                    <query></query>
                    <slots>0,1</slots>
                  </card>
                </fronts>
                <backs>
                  <card><id></id><name></name><slots></slots></card>
                  <card><id>shared_back_1</id><name>Shared Back</name><slots>0,1</slots></card>
                </backs>
              </order>`;

            const intents = parseMpcXml(xml);

            expect(intents).toEqual([
                expect.objectContaining({
                    name: 'Custom Card',
                    quantity: 2,
                    mpcId: undefined,
                    linkedBackImageId: 'shared_back_1',
                    linkedBackName: 'Shared Back',
                }),
            ]);
        });

        it('uses query text in MPC XML different-back warnings when the name is absent', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const xml = `
              <order>
                <fronts>
                  <card>
                    <id>front_query_only</id>
                    <name></name>
                    <query>Query Only</query>
                    <slots>0,1</slots>
                  </card>
                </fronts>
                <backs>
                  <card><id>back_query_a</id><name>Back A</name><slots>0</slots></card>
                  <card><id>back_query_b</id><name>Back B</name><slots>1</slots></card>
                </backs>
              </order>`;

            parseMpcXml(xml);

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Card "Query Only" has different backs per slot'));
            warnSpy.mockRestore();
        });
    });

    describe('createIntentFromPreloaded', () => {
        it('creates correct intent from raw object', () => {
            const card = { name: 'Black Lotus', set: 'lea' };
            const intent = createIntentFromPreloaded(card, { quantity: 4 });
            expect(intent).toEqual(expect.objectContaining({
                name: 'Black Lotus',
                quantity: 4,
                isToken: false,
                sourcePreference: 'manual'
            }));
        });

        it('uses safe defaults for incomplete preloaded card data', () => {
            const intent = createIntentFromPreloaded({});

            expect(intent).toEqual(expect.objectContaining({
                name: 'Unknown Card',
                quantity: 1,
                isToken: false,
                sourcePreference: 'manual',
            }));
        });
    });

    describe('parseDeckBuilderUrl', () => {
        it('calls Moxfield API for moxfield URLs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fetchMock = vi.spyOn(moxfieldApi, 'fetchMoxfieldDeck').mockResolvedValue({ name: 'Test Deck' } as any);
            vi.spyOn(moxfieldApi, 'extractCardsFromDeck').mockReturnValue([
                { name: 'Card A', quantity: 2, set: 'abc', number: '1', scryfallId: '1', category: 'Mainboard' }
            ]);

            const result = await parseDeckBuilderUrl('https://moxfield.com/decks/test');

            expect(fetchMock).toHaveBeenCalled();
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Card A');
            expect(result[0].quantity).toBe(2);
        });

        it('calls Archidekt API for archidekt URLs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fetchMock = vi.spyOn(archidektApi, 'fetchArchidektDeck').mockResolvedValue({ id: 123 } as any);
            vi.spyOn(archidektApi, 'extractCardsFromDeck').mockReturnValue([
                { name: 'Arch Card', quantity: 1, category: 'Sideboard' }
            ]);

            const result = await parseDeckBuilderUrl('https://archidekt.com/decks/123/test');

            expect(fetchMock).toHaveBeenCalled();
            expect(result).toEqual([
                expect.objectContaining({ name: 'Arch Card', category: 'Sideboard' }),
            ]);
        });

        it('throws for unsupported deck builder URLs', async () => {
            await expect(parseDeckBuilderUrl('https://example.com/deck')).rejects.toThrow('Unsupported URL format');
        });
    });

    describe('parseDeckList', () => {
        it('parses multiple lines', () => {
            const deckText = `4 Sol Ring
2 Lightning Bolt
1 Mountain`;
            const result = parseDeckList(deckText);
            expect(result).toHaveLength(3);
            expect(result[0]).toEqual(expect.objectContaining({ name: 'Sol Ring', quantity: 4 }));
            expect(result[1]).toEqual(expect.objectContaining({ name: 'Lightning Bolt', quantity: 2 }));
            expect(result[2]).toEqual(expect.objectContaining({ name: 'Mountain', quantity: 1 }));
        });

        it('skips empty lines', () => {
            const deckText = `4 Sol Ring

2 Lightning Bolt

`;
            const result = parseDeckList(deckText);
            expect(result).toHaveLength(2);
        });

        it('handles CRLF line endings', () => {
            const deckText = "4 Sol Ring\r\n2 Lightning Bolt\r\n";
            const result = parseDeckList(deckText);
            expect(result).toHaveLength(2);
        });

        it('parses deck with set/number annotations', () => {
            const deckText = `4 Sol Ring [2xm] {1}
1 Black Lotus [lea] {232}`;
            const result = parseDeckList(deckText);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(expect.objectContaining({
                name: 'Sol Ring',
                quantity: 4,
                set: '2xm',
                number: '1'
            }));
        });

        it('returns empty array for empty input', () => {
            expect(parseDeckList('')).toEqual([]);
            expect(parseDeckList('   \n   \n   ')).toEqual([]);
        });

        it('detects and normalizes category headers', () => {
            const result = parseDeckList(`// Sideboard\n1 Negate\nmaybe:\n1 Unsummon\nside\n1 Duress\nDECK\n1 Island`);

            expect(result).toEqual([
                expect.objectContaining({ name: 'Negate', category: 'Sideboard' }),
                expect.objectContaining({ name: 'Unsummon', category: 'Maybeboard' }),
                expect.objectContaining({ name: 'Duress', category: 'Sideboard' }),
                expect.objectContaining({ name: 'Island', category: 'Mainboard' }),
            ]);
        });
    });
});
