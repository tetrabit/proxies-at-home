import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nginxConfig = fs.readFileSync(path.join(clientRoot, 'nginx.conf'), 'utf8');
const viteConfig = fs.readFileSync(path.join(clientRoot, 'vite.config.ts'), 'utf8');

describe('calibration harness proxy host preservation', () => {
  it('keeps the public Host including its port across nginx and Vite /api proxies', () => {
    expect(nginxConfig).toMatch(/location\s+\/api\/\s*\{[\s\S]*?proxy_set_header\s+Host\s+\$http_host;/);
    expect(viteConfig).toMatch(/proxy:\s*\{[\s\S]*?"\/api":\s*\{[\s\S]*?changeOrigin:\s*false/);
  });
});
