#!/usr/bin/env node
'use strict';

/**
 * Assign an application role to a user by setting the Firebase `role` custom
 * claim that the gateway reads (packages/shared/src/authz.js).
 *
 *   node services/gateway/scripts/set-user-role.js <email> <admin|operator|viewer>
 *
 * Auth: Application Default Credentials (gcloud auth application-default login,
 * or a service account with Firebase Auth admin). Project from
 * FIREBASE_PROJECT_ID / GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT.
 *
 * The user must re-authenticate (or let their ID token refresh, ~1h) for the new
 * role to take effect. Pass role `none` to clear the claim (→ default role).
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const ROLES = ['admin', 'operator', 'viewer'];

async function main() {
  const [email, role] = process.argv.slice(2);
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;

  if (!email || !role || (role !== 'none' && !ROLES.includes(role))) {
    console.error(`Usage: set-user-role.js <email> <${ROLES.join('|')}|none>`);
    process.exit(1);
  }
  if (!projectId) {
    console.error('Set FIREBASE_PROJECT_ID (or GCP_PROJECT_ID) to the target project.');
    process.exit(1);
  }

  if (!getApps().length) initializeApp({ projectId });
  const auth = getAuth();
  const user = await auth.getUserByEmail(email);

  const claims = { ...(user.customClaims || {}) };
  if (role === 'none') delete claims.role;
  else claims.role = role;
  await auth.setCustomUserClaims(user.uid, claims);

  console.log(`OK: ${email} (uid ${user.uid}) role=${role === 'none' ? '(cleared → default)' : role}.`);
  console.log('The user must sign out/in (or wait for the ~1h ID-token refresh) for it to take effect.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
