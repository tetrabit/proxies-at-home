import { randomBytes } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  createPrivateRouteAuth,
  createSingleBearerVerifier,
  type PrivateCapability,
  type PrivateCredentialVerifier,
  type PrivateIdentity,
} from './privateRouteAuth.js';

describe('private route authorization seam', () => {
  it('rejects a request without Authorization before the protected handler', async () => {
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(),
    };
    const handler = vi.fn((_req, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const response = await request(app).get('/private');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(verifier.verifyBearer).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts a configured server-derived identity and exposes it to the protected handler', async () => {
    const bearer = randomBytes(32).toString('base64url');
    const identity: PrivateIdentity = {
      ownerId: 'server-owned-owner',
      capabilities: new Set(['metrics:read']),
      transport: 'server',
    };
    const app = express();
    app.get(
      '/private',
      createPrivateRouteAuth(createSingleBearerVerifier(bearer, identity)).private('metrics:read'),
      (request, response) => response.json({
        ownerId: request.privateIdentity?.ownerId,
        capabilities: [...(request.privateIdentity?.capabilities ?? [])],
        transport: request.privateIdentity?.transport,
      }),
    );

    const response = await request(app)
      .get('/private?ownerId=client-owner&capability=backup:write')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Owner-Id', 'client-owner')
      .set('X-Capability', 'backup:write');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ownerId: 'server-owned-owner',
      capabilities: ['metrics:read'],
      transport: 'server',
    });
  });

  it.each([
    undefined,
    'Basic credential',
    'Bearer',
    'Bearer  credential',
    'Bearer credential,other',
  ])('rejects malformed Authorization header %j before the protected handler', async (authorization) => {
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(),
    };
    const handler = vi.fn((_request, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const requestBuilder = request(app).get('/private');
    if (authorization !== undefined) {
      requestBuilder.set('Authorization', authorization);
    }
    const response = await requestBuilder;

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(verifier.verifyBearer).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects duplicate Authorization headers before the protected handler', async () => {
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(),
    };
    const handler = vi.fn((_request, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const response = await request(app)
      .get('/private')
      .set('Authorization', ['Bearer first', 'Bearer second'] as unknown as string);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(verifier.verifyBearer).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an invalid verifier identity before the protected handler', async () => {
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(() => undefined as never),
    };
    const handler = vi.fn((_request, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const response = await request(app).get('/private').set('Authorization', 'Bearer valid-shape');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unknown bearer before the protected handler', async () => {
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(() => null),
    };
    const handler = vi.fn((_request, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const response = await request(app).get('/private').set('Authorization', 'Bearer valid-shape');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a verified identity without the required capability before the protected handler', async () => {
    const identity: PrivateIdentity = {
      ownerId: 'server-owned-owner',
      capabilities: new Set<PrivateCapability>(['backup:read']),
      transport: 'server',
    };
    const verifier: PrivateCredentialVerifier = {
      verifyBearer: vi.fn(() => identity),
    };
    const handler = vi.fn((_request, response) => response.json({ reached: true }));
    const app = express();
    app.get('/private', createPrivateRouteAuth(verifier).private('metrics:read'), handler);

    const response = await request(app).get('/private').set('Authorization', 'Bearer valid-shape');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not emit accepted or rejected bearer values to console', async () => {
    const bearer = randomBytes(32).toString('base64url');
    const identity: PrivateIdentity = {
      ownerId: 'server-owned-owner',
      capabilities: new Set(['metrics:read']),
      transport: 'server',
    };
    const app = express();
    app.get(
      '/private',
      createPrivateRouteAuth(createSingleBearerVerifier(bearer, identity)).private('metrics:read'),
      (_request, response) => response.json({ reached: true }),
    );
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    try {
      await request(app).get('/private').set('Authorization', `Bearer ${bearer}`);
      await request(app).get('/private').set('Authorization', 'Bearer rejected-bearer');

      for (const consoleSpy of consoleSpies) {
        const messages = consoleSpy.mock.calls.flat().map(String);
        expect(messages.some((message) => message.includes(bearer))).toBe(false);
        expect(messages.some((message) => message.includes('rejected-bearer'))).toBe(false);
      }
    } finally {
      for (const consoleSpy of consoleSpies) {
        consoleSpy.mockRestore();
      }
    }
  });
});
