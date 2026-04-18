import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Router } from 'express';
import type {
    MpcPreferenceCandidate,
    MpcPreferenceCase,
    MpcPreferenceComparisonHints,
    MpcPreferenceFixture,
    MpcPreferenceSourceCardSnapshot,
} from '../../../shared/types.js';

const DEFAULT_PREFERENCES_FILENAME = 'mpc-preferences.user.json';

type JsonRecord = Record<string, unknown>;

interface PreferencesRouterOptions {
    dataDirectory?: string;
    configuredPath?: string | undefined;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isNumberOrNullRecord(value: unknown): value is Record<string, number | null> {
    return isRecord(value) && Object.values(value).every(item => typeof item === 'number' || item === null);
}

function validateCandidate(candidate: unknown): MpcPreferenceCandidate {
    if (!isRecord(candidate)) {
        throw new Error('Invalid preference fixture: candidate must be an object');
    }

    if (
        typeof candidate.identifier !== 'string' ||
        typeof candidate.name !== 'string' ||
        typeof candidate.rawName !== 'string' ||
        typeof candidate.smallThumbnailUrl !== 'string' ||
        typeof candidate.mediumThumbnailUrl !== 'string' ||
        !isOptionalString(candidate.imageUrl) ||
        typeof candidate.dpi !== 'number' ||
        !Array.isArray(candidate.tags) ||
        !candidate.tags.every(tag => typeof tag === 'string') ||
        typeof candidate.sourceName !== 'string' ||
        typeof candidate.source !== 'string' ||
        typeof candidate.extension !== 'string' ||
        typeof candidate.size !== 'number'
    ) {
        throw new Error('Invalid preference fixture: malformed candidate');
    }

    return {
        identifier: candidate.identifier,
        name: candidate.name,
        rawName: candidate.rawName,
        smallThumbnailUrl: candidate.smallThumbnailUrl,
        mediumThumbnailUrl: candidate.mediumThumbnailUrl,
        imageUrl: candidate.imageUrl,
        dpi: candidate.dpi,
        tags: candidate.tags,
        sourceName: candidate.sourceName,
        source: candidate.source,
        extension: candidate.extension,
        size: candidate.size,
    };
}

function validateCase(testCase: unknown): MpcPreferenceCase {
    if (!isRecord(testCase)) {
        throw new Error('Invalid preference fixture: case must be an object');
    }

    const { source, candidates, expectedIdentifier, notes, comparisonHints } = testCase;

    if (!isRecord(source) || typeof source.name !== 'string') {
        throw new Error('Invalid preference fixture: malformed source card');
    }

    if (
        !isOptionalString(source.set) ||
        !isOptionalString(source.collectorNumber) ||
        !isOptionalString(source.sourceImageUrl) ||
        !isOptionalString(source.sourceArtImageUrl)
    ) {
        throw new Error('Invalid preference fixture: malformed source card');
    }

    if (!Array.isArray(candidates)) {
        throw new Error('Invalid preference fixture: candidates must be an array');
    }

    const validatedCandidates = candidates.map(candidate => validateCandidate(candidate));

    if (!isOptionalString(expectedIdentifier) || !isOptionalString(notes)) {
        throw new Error('Invalid preference fixture: malformed case metadata');
    }

    let validatedComparisonHints: MpcPreferenceComparisonHints | undefined;
    if (comparisonHints !== undefined) {
        if (!isRecord(comparisonHints)) {
            throw new Error('Invalid preference fixture: malformed comparison hints');
        }

        if (
            (comparisonHints.fullCard !== undefined && !isNumberOrNullRecord(comparisonHints.fullCard)) ||
            (comparisonHints.artMatch !== undefined && !isNumberOrNullRecord(comparisonHints.artMatch))
        ) {
            throw new Error('Invalid preference fixture: malformed comparison hints');
        }

        validatedComparisonHints = {
            ...(comparisonHints.fullCard !== undefined ? { fullCard: comparisonHints.fullCard } : {}),
            ...(comparisonHints.artMatch !== undefined ? { artMatch: comparisonHints.artMatch } : {}),
        };
    }

    const validatedSource: MpcPreferenceSourceCardSnapshot = {
        name: source.name,
        ...(source.set !== undefined ? { set: source.set } : {}),
        ...(source.collectorNumber !== undefined ? { collectorNumber: source.collectorNumber } : {}),
        ...(source.sourceImageUrl !== undefined ? { sourceImageUrl: source.sourceImageUrl } : {}),
        ...(source.sourceArtImageUrl !== undefined ? { sourceArtImageUrl: source.sourceArtImageUrl } : {}),
    };

    return {
        source: validatedSource,
        candidates: validatedCandidates,
        ...(expectedIdentifier !== undefined ? { expectedIdentifier } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(validatedComparisonHints !== undefined ? { comparisonHints: validatedComparisonHints } : {}),
    };
}

export function validatePreferenceFixture(data: unknown): MpcPreferenceFixture {
    if (!isRecord(data)) {
        throw new Error('Invalid preference fixture: not a JSON object');
    }

    if (typeof data.version !== 'number') {
        throw new Error('Invalid preference fixture: missing version');
    }

    if (typeof data.exportedAt !== 'string') {
        throw new Error('Invalid preference fixture: missing exportedAt');
    }

    if (!Array.isArray(data.cases)) {
        throw new Error('Invalid preference fixture: missing cases array');
    }

    return {
        version: data.version,
        exportedAt: data.exportedAt,
        cases: data.cases.map(testCase => validateCase(testCase)),
    };
}

export function resolvePreferencesFilePath(
    configuredPath: string | undefined,
    dataDirectory: string
): string {
    const resolvedDataDirectory = path.resolve(dataDirectory);
    const rawPath = configuredPath?.trim() || DEFAULT_PREFERENCES_FILENAME;
    const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(resolvedDataDirectory, rawPath);
    const relativePath = path.relative(resolvedDataDirectory, resolvedPath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(
            `MPC_PREFERENCES_PATH must stay within ${resolvedDataDirectory}`
        );
    }

    return resolvedPath;
}

async function writeJsonAtomically(filePath: string, payload: string): Promise<void> {
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

    await fs.mkdir(directory, { recursive: true });

    try {
        await fs.writeFile(tempPath, payload, 'utf-8');
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await fs.unlink(tempPath).catch(() => undefined);
        throw error;
    }
}

export function createPreferencesRouter(options: PreferencesRouterOptions = {}): Router {
    const router = Router();
    const dataDirectory = options.dataDirectory ?? path.resolve(process.cwd(), 'data');
    const filePath = resolvePreferencesFilePath(options.configuredPath ?? process.env.MPC_PREFERENCES_PATH, dataDirectory);

    let pendingWrite = Promise.resolve();

    router.get('/', async (_req, res) => {
        try {
            const payload = await fs.readFile(filePath, 'utf-8');
            const parsed = validatePreferenceFixture(JSON.parse(payload));
            res.json(parsed);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                res.status(404).json({ error: 'Preferences not found' });
                return;
            }

            console.error('[Preferences] Error loading preferences:', error);
            res.status(500).json({ error: 'Failed to load preferences' });
        }
    });

    router.put('/', async (req, res) => {
        let fixture: MpcPreferenceFixture;

        try {
            fixture = validatePreferenceFixture(req.body);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid preference fixture';
            res.status(400).json({ error: message });
            return;
        }

        const payload = `${JSON.stringify(fixture, null, 2)}\n`;

        try {
            const writeOperation = pendingWrite.then(() => writeJsonAtomically(filePath, payload));
            pendingWrite = writeOperation.catch(() => undefined);
            await writeOperation;
            res.json({ saved: true });
        } catch (error) {
            console.error('[Preferences] Error saving preferences:', error);
            res.status(500).json({ error: 'Failed to save preferences' });
        }
    });

    return router;
}

export const preferencesRouter = createPreferencesRouter();
