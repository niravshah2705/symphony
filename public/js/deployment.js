// Deployment-resolution polling for the SPA.
//
// When a newly-created org's dedicated stack is still coming up, GET /api/config
// (on the SHARED gateway) reports status 'provisioning'. This polls it until it
// leaves that state (→ 'provisioned' | 'shared' | 'failed'), so the SPA can then
// re-point at the per-tenant gateway. Kept pure + injectable (fetchConfig/sleep)
// so it is unit-testable without a browser.

/**
 * @param {object} opts
 * @param {() => Promise<{status?: string}>} opts.fetchConfig  resolver fetch (GET /api/config)
 * @param {(status: string) => void} [opts.onStatus]           called on each observed status
 * @param {number} [opts.delayMs]                              between polls (default 3000)
 * @param {number} [opts.maxAttempts]                          give up after N (default 100 → ~5 min)
 * @param {(ms: number) => Promise<void>} [opts.sleep]         injectable wait (tests)
 * @returns {Promise<object|null>} the last config observed (or null if never fetched)
 */
export async function pollUntilResolved({ fetchConfig, onStatus, delayMs = 3000, maxAttempts = 100, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let cfg = null;
    try {
      cfg = await fetchConfig();
    } catch (_) {
      cfg = null; // transient error — keep polling
    }
    if (cfg) {
      last = cfg;
      if (onStatus) onStatus(cfg.status);
      if (cfg.status !== 'provisioning') return cfg;
    }
    await wait(delayMs);
  }
  return last;
}
