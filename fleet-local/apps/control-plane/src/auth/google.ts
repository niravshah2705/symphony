import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.ts';

// Google publishes rotating signing keys here; jose caches the JWKS in-process.
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function remoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

// Verify a Google ID token (the Bearer that oauth2-proxy --set-authorization-header
// delivers). Signature IS verified here — unlike the kagent controller's
// trusted-proxy mode, the BFF is a real OIDC relying party.
export async function verifyGoogleIdToken(token: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, remoteJwks(), {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.googleClientId,
  });
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!payload.sub || !email) throw new Error('ID token missing sub/email');
  if (payload.email_verified === false) throw new Error('email not verified');
  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}