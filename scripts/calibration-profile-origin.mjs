const origins = new Map([
  ['http://127.0.0.1:5173', 'http_127.0.0.1_5173.indexeddb'],
  ['http://localhost:5173', 'http_localhost_5173.indexeddb'],
]);

export function resolveCalibrationExportOrigin(origin = 'http://127.0.0.1:5173') {
  const indexedDbPrefix = origins.get(origin);
  if (!indexedDbPrefix) throw new Error('Unsupported calibration export origin');
  return { origin, indexedDbPrefix };
}
