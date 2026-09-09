import { createHash, timingSafeEqual } from 'node:crypto';

import type { Request, RequestHandler } from 'express';

export type PrivateCapability =
  | 'backup:read'
  | 'backup:write'
  | 'preferences:read'
  | 'preferences:write'
  | 'calibration:read'
  | 'calibration:write'
  | 'metrics:read'
  | 'metrics:write';

export type PrivateIdentity = {
  ownerId: string;
  capabilities: ReadonlySet<PrivateCapability>;
  transport: 'desktop-loopback' | 'server';
};

export interface PrivateCredentialVerifier {
  verifyBearer(bearer: string): PrivateIdentity | null | Promise<PrivateIdentity | null>;
}

declare module 'express-serve-static-core' {
  interface Request {
    privateIdentity?: PrivateIdentity;
  }
}

const privateCapabilities = new Set<PrivateCapability>([
  'backup:read',
  'backup:write',
  'preferences:read',
  'preferences:write',
  'calibration:read',
  'calibration:write',
  'metrics:read',
  'metrics:write',
]);

function isPrivateIdentity(value: unknown): value is PrivateIdentity {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const identity = value as {
    ownerId?: unknown;
    capabilities?: unknown;
    transport?: unknown;
  };

  return typeof identity.ownerId === 'string'
    && identity.capabilities instanceof Set
    && [...identity.capabilities].every((capability) => privateCapabilities.has(capability))
    && (identity.transport === 'desktop-loopback' || identity.transport === 'server');
}

function parseBearer(request: Request): string | null {
  const authorizationHeaders = request.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && _value.toLowerCase() === 'authorization',
  );
  const authorization = request.headers.authorization;

  if (authorizationHeaders.length !== 1 || typeof authorization !== 'string') {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/.exec(authorization);
  return match?.[1] ?? null;
}

function credentialDigest(bearer: string): Buffer {
  return createHash('sha256').update(bearer).digest();
}

export function createSingleBearerVerifier(
  configuredBearer: string,
  identity: PrivateIdentity,
): PrivateCredentialVerifier {
  const configuredDigest = credentialDigest(configuredBearer);

  return {
    verifyBearer(presentedBearer: string): PrivateIdentity | null {
      const presentedDigest = credentialDigest(presentedBearer);
      return timingSafeEqual(configuredDigest, presentedDigest) ? identity : null;
    },
  };
}

export function createPrivateRouteAuth(verifier: PrivateCredentialVerifier): {
  private(capability: PrivateCapability): RequestHandler;
} {
  return {
    private: (capability) => async (request, response, next) => {
      const bearer = parseBearer(request);
      if (bearer === null) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }

      let identity: PrivateIdentity | null;
      try {
        identity = await verifier.verifyBearer(bearer);
      } catch {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }

      if (!isPrivateIdentity(identity)) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }

      if (!identity.capabilities.has(capability)) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }

      request.privateIdentity = identity;
      next();
    },
  };
}
