import { config } from '../config.ts';
import { QoderAuthError, qoder, type QoderTokenSet } from '../clients/qoder.ts';
import { getJson, listJson, patchSecret } from '../clients/k8s.ts';
import { orgStatus } from '../db/orgs.ts';

// Keep a tenant's Qoder credential current.
//
// The EgressPolicy substitutes the tenant Secret's `QODER_API_KEY` value into
// `Authorization: Bearer ...` on the Qoder origins that carry a job token, while the
// CLI inside the Actor holds only an inert placeholder. So that Secret must always
// contain a *live* `jt-...`: this module is its only writer, it reads the long-lived
// PAT from the same Secret, and it never lets a PAT or refresh token reach a header,
// argv, a log line, or the Actor.
//
// State lives on the Secret's annotations, not the DB: the loop has to be correct
// after a BFF restart without a migration, and the Secret is already the object the
// policy reads.

export interface QoderTenantRef {
  namespace: string;
  secretName: string;
  orgId: string;
}

export interface QoderSecretState {
  data: Record<string, string>;
  annotations: Record<string, string>;
}

export interface QoderTokenDeps {
  listTenants(): Promise<QoderTenantRef[]>;
  readSecret(ref: QoderTenantRef): Promise<QoderSecretState | undefined>;
  writeSecret(ref: QoderTenantRef, patch: { data: Record<string, string>; annotations: Record<string, string> }): Promise<void>;
  status(orgId: string): Promise<string | undefined>;
  exchange(pat: string): Promise<QoderTokenSet>;
  refresh(refreshToken: string): Promise<QoderTokenSet>;
  now(): number;
  skewSeconds(): number;
}

export interface QoderRotationResult extends Partial<QoderTenantRef> {
  action: 'fresh' | 'exchanged' | 'refreshed' | 'skipped';
  reason?: string;
}

const ANNOT_TOKEN_EXPIRES = 'fleet.local/qoder-token-expires-at';
const ANNOT_REFRESH_EXPIRES = 'fleet.local/qoder-refresh-expires-at';
const ANNOT_SYNCED = 'fleet.local/qoder-token-synced-at';

const decode = (value: string | undefined): string =>
  value ? Buffer.from(value, 'base64').toString('utf8').trim() : '';

const epoch = (value: string | undefined): number => {
  const n = Number(value ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// The decision, with every effect injected, so the table is testable without a
// cluster or a network (the real step bodies, which import the clients directly,
// are not).
export async function ensureQoderToken(
  ref: QoderTenantRef,
  deps: Omit<QoderTokenDeps, 'listTenants'>,
): Promise<QoderRotationResult> {
  const secret = await deps.readSecret(ref);
  if (!secret) return { ...ref, action: 'skipped', reason: 'no_secret' };

  const pat = decode(secret.data[config.qoderPatSecretKey]);
  if (!pat) return { ...ref, action: 'skipped', reason: 'no_pat' };

  // DISABLE IS A GATE, NOT A TEARDOWN: a disabled org stops rotating but keeps its
  // Secret, and an offboarding/deleted org is torn down by the offboarding machine.
  const status = await deps.status(ref.orgId);
  if (status !== 'active') return { ...ref, action: 'skipped', reason: `org_${status ?? 'unknown'}` };

  const now = Math.floor(deps.now() / 1000);
  const skew = deps.skewSeconds();
  const tokenKey = config.qoderApiKeyEnv;
  const refreshKey = config.qoderRefreshSecretKey;
  const current = decode(secret.data[tokenKey]);
  const expiresAt = epoch(secret.annotations[ANNOT_TOKEN_EXPIRES]);

  if (current.startsWith('jt-') && expiresAt > 0 && now < expiresAt - skew) {
    return { ...ref, action: 'fresh' };
  }

  let minted: QoderTokenSet | undefined;
  let action: 'exchanged' | 'refreshed' = 'exchanged';
  const refreshToken = decode(secret.data[refreshKey]);
  const refreshExpires = epoch(secret.annotations[ANNOT_REFRESH_EXPIRES]);
  if (refreshToken && (refreshExpires === 0 || now < refreshExpires - skew)) {
    try {
      minted = await deps.refresh(refreshToken);
      action = 'refreshed';
    } catch (err) {
      // A rejected refresh (past its 48h window, or revoked) is expected; the PAT is
      // still good, so exchange. A server error is not: leave the Secret untouched
      // rather than burn a PAT against a failing endpoint.
      if (!(err instanceof QoderAuthError) || err.status >= 500) throw err;
    }
  }
  if (!minted) {
    minted = await deps.exchange(pat);
    action = 'exchanged';
  }

  await deps.writeSecret(ref, {
    data: {
      [tokenKey]: Buffer.from(minted.token).toString('base64'),
      ...(minted.refreshToken ? { [refreshKey]: Buffer.from(minted.refreshToken).toString('base64') } : {}),
    },
    annotations: {
      ...secret.annotations,
      [ANNOT_TOKEN_EXPIRES]: String(minted.expiresAt),
      [ANNOT_REFRESH_EXPIRES]: String(minted.refreshExpiresAt ?? 0),
      [ANNOT_SYNCED]: new Date(deps.now()).toISOString(),
    },
  });
  return { ...ref, action };
}

const cluster: QoderTokenDeps = {
  // The tenant Secret is the only object that carries the org label *and* the
  // credential, so it doubles as the inventory: no DB scan, no namespace list.
  async listTenants() {
    const found = await listJson<{ metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } }>(
      'secrets',
      'fleet.local/org-id',
    );
    return found
      .map((s) => ({
        namespace: s.metadata?.namespace ?? '',
        secretName: s.metadata?.name ?? '',
        orgId: s.metadata?.labels?.['fleet.local/org-id'] ?? '',
      }))
      .filter((s) => s.namespace !== '' && s.secretName !== '' && s.orgId !== '');
  },
  async readSecret(ref) {
    const secret = await getJson<{ data?: Record<string, string>; metadata?: { annotations?: Record<string, string> } }>(
      'secret',
      ref.secretName,
      ref.namespace,
    );
    return secret ? { data: secret.data ?? {}, annotations: secret.metadata?.annotations ?? {} } : undefined;
  },
  writeSecret: (ref, patch) => patchSecret(ref.secretName, ref.namespace, patch),
  status: (orgId) => orgStatus(orgId),
  exchange: (pat) => qoder.exchange(pat),
  refresh: (rt) => qoder.refresh(rt),
  now: () => Date.now(),
  skewSeconds: () => config.qoderTokenSkewSeconds,
};

// The onboarding path's entry point: one tenant, cluster deps bound.
export function mintQoderToken(ref: QoderTenantRef): Promise<QoderRotationResult> {
  return ensureQoderToken(ref, cluster);
}

export async function rotateQoderTokens(deps: QoderTokenDeps = cluster): Promise<QoderRotationResult[]> {
  const results: QoderRotationResult[] = [];
  for (const ref of await deps.listTenants()) {
    try {
      results.push(await ensureQoderToken(ref, deps));
    } catch (err) {
      // One tenant's failure must not stop the rest, and the message is the only
      // thing printed: QoderAuthError is body-free by construction.
      console.error(
        `qoder token rotation failed for ${ref.namespace}/${ref.secretName}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return results;
}

// Same shape as startSweeper(): unref'd, self-contained error boundary, cleared by
// the server's shutdown. Its own interval, so credential rotation never rides the
// billing sweep's traffic.
export function startQoderTokenLoop(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void rotateQoderTokens().catch((err) => console.error('qoder token loop error:', err));
  }, config.qoderTokenIntervalSeconds * 1000);
  timer.unref();
  return timer;
}
