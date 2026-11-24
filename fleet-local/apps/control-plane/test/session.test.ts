import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { config } from '../src/config.ts';
import { mintSession, readSession } from '../src/auth/session.ts';

const secret = new TextEncoder().encode(config.sessionSecret);
const UUID = '11111111-2222-4333-8444-555555555555';

async function sign(sub: string): Promise<string> {
  return new SignJWT({ email: 'nirav@example.com' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('900s')
    .sign(secret);
}

test('a minted session round-trips to its uid and email', async () => {
  const token = await mintSession({ uid: UUID, email: 'nirav@example.com' });
  assert.deepEqual(await readSession(token), { uid: UUID, email: 'nirav@example.com' });
});

test('a garbage or wrongly-signed token is no session at all', async () => {
  assert.equal(await readSession('not-a-jwt'), undefined);
  const other = new TextEncoder().encode('a-different-secret-entirely');
  const forged = await new SignJWT({ email: 'nirav@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(UUID)
    .setExpirationTime('900s')
    .sign(other);
  assert.equal(await readSession(forged), undefined);
});

test('a well-signed token with a non-uuid sub is rejected, not crashed on', async () => {
  // users.id is a uuid column. Before this guard, a sub of "501" reached the
  // driver and every route answered
  // 500 invalid input syntax for type uuid: "501" (found by t31).
  assert.equal(await readSession(await sign('501')), undefined);
  assert.equal(await readSession(await sign(`${UUID}x`)), undefined);
});
