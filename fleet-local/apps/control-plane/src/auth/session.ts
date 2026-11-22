import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.ts';

const secret = new TextEncoder().encode(config.sessionSecret);
const ALG = 'HS256';

export interface SessionClaims {
  uid: string;
  email: string;
}

export async function mintSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.uid)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlSeconds}s`)
    .sign(secret);
}

export async function readSession(token: string): Promise<SessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    if (!payload.sub || typeof payload.email !== 'string') return undefined;
    return { uid: payload.sub, email: payload.email };
  } catch {
    return undefined;
  }
}