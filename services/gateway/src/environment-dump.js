'use strict';

const ALLOWED_ENVIRONMENT_DUMP_EMAIL = 'niravshah2705@gmail.com';

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sortedEnvironment(env) {
  return Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((key) => [key, env[key]]),
  );
}

function setNoCacheHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res;
}

function environmentDumpNoCache(_req, res, next) {
  setNoCacheHeaders(res);
  return next();
}

/**
 * Temporary, authenticated gateway environment dump.
 *
 * This deliberately returns credential-bearing values verbatim for a one-time
 * operator task. Remove this module and its route immediately after retrieval.
 *
 * `env` and `now` are injectable so the response can be tested without reading
 * or modifying the test runner's process environment or clock. The authorized
 * identity is intentionally not injectable.
 */
function createEnvironmentDumpHandler({ env = process.env, now = () => new Date() } = {}) {
  return function environmentDump(req, res) {
    setNoCacheHeaders(res);

    const auth = req.auth;
    const email = normalizedEmail(auth?.user?.email);
    if (auth?.authenticated !== true || email !== ALLOWED_ENVIRONMENT_DUMP_EMAIL) {
      return res.status(403).json({
        error: 'Access denied',
        code: 'access_denied',
      });
    }

    return res.json({
      service: 'gateway',
      generatedAt: now().toISOString(),
      environment: sortedEnvironment(env),
    });
  };
}

module.exports = {
  ALLOWED_ENVIRONMENT_DUMP_EMAIL,
  createEnvironmentDumpHandler,
  environmentDumpNoCache,
};
