'use strict';

/**
 * Container entrypoint. One coder image serves two roles (DRY):
 *   CODER_ROLE=worker  → the Cloud Run Job worker (job.js), runs one ticket, exits
 *   otherwise          → the coder-control Cloud Run service (index.js)
 *
 * Local dev runs index.js directly (see scripts/start-all.js); this dispatcher
 * is used by the container CMD.
 */
if (String(process.env.CODER_ROLE || '').trim() === 'worker') {
  void require('./job').main();
} else {
  require('./index');
}
