import fs from 'node:fs/promises';
import path from 'node:path';

const sourcePath = process.argv[2] || process.env.MPC_PREFERENCES_SOURCE;

if (!sourcePath) {
  throw new Error(
    'Usage: npm run preferences:promote -- /absolute/path/to/mpc-preferences.user.json'
  );
}

const destinationPath = path.resolve('tests/fixtures/mpc-preference-defaults.v1.json');
const payload = JSON.parse(await fs.readFile(sourcePath, 'utf8'));

if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.cases)) {
  throw new Error('Source file is not a valid MPC preference fixture');
}

const normalizedPayload = payload.version && payload.exportedAt
  ? {
      cases: payload.cases.map((calibrationCase) => ({
        name: calibrationCase.source?.name,
        expectedIdentifier: calibrationCase.expectedIdentifier,
        candidates: calibrationCase.candidates,
      })),
    }
  : payload;

await fs.writeFile(destinationPath, `${JSON.stringify(normalizedPayload, null, 2)}\n`, 'utf8');

console.log(`Promoted preferences from ${sourcePath} to ${destinationPath}`);
