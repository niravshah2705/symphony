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
    // users.id is a uuid column, so a non-uuid sub is not a user — and letting it
    // reach the driver turns a bad token into a 500 (proved by t31: a minted
    // cookie with sub="501" answered every route with
    // "invalid input syntax for type uuid"). Reject it as the invalid session it is.
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(payload.sub)) {
      return undefined;
    }
    return { uid: payload.sub, email: payload.email };
  } catch {
    return undefined;
  }
}