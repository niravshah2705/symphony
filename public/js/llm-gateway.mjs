// Per-request LLM gateway opt-in (feature flag), read out of device storage.
//
// The header is honored only on deployments whose own gate is on
// (`LLM_GATEWAY_ENABLED` / `LITELLM_GATEWAY_ENABLED`), and an unknown value is
// dropped here rather than forwarded. The mode list must stay a subset of
// shared-core's CONFIG.LLM_GATEWAY_MODES — the browser bundle cannot import it,
// so this copy is deliberately duplicated.

export const LLM_GATEWAY_STORAGE_KEY = 'aiFleetLlmGateway';
export const LLM_GATEWAY_MODES = Object.freeze(['langsmith', 'litellm']);

/**
 * The flag for ONE organization.
 *
 * Per-tenant because the flag is a per-tenant capability: it routes that tenant's
 * runs through a gateway that only some deployments configure. `aiFleetLlmGateway`
 * on its own stays the global fallback, so the documented devtools toggle —
 * `localStorage.setItem('aiFleetLlmGateway', 'litellm')` — keeps applying
 * everywhere, while `aiFleetLlmGateway:<organizationId>` pins one customer
 * without dragging its siblings onto a gateway they have not set up.
 */
export function readLlmGatewayFlag({ storage, organizationId = '' } = {}) {
  try {
    const scoped = organizationId
      ? storage.getItem(`${LLM_GATEWAY_STORAGE_KEY}:${organizationId}`)
      : null;
    const value = String(scoped ?? storage.getItem(LLM_GATEWAY_STORAGE_KEY) ?? '')
      .trim()
      .toLowerCase();
    return LLM_GATEWAY_MODES.includes(value) ? value : '';
  } catch (_) {
    return ''; /* storage unavailable (private mode) — flag off */
  }
}
