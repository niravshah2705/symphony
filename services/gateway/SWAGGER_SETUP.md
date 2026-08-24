# Gateway Service — Swagger API Documentation Setup

## Quick Start

### Local Development

No setup required. After `npm start`, open:

```
http://localhost:4000/api/docs
```

### Cloud Production

You need to send the `x-ai-fleet-api-docs` header. Use the [ModHeader](https://modheader.com/) browser extension:

1. Install [ModHeader](https://modheader.com/)
2. Click the extension icon → **Add rule**
3. Set up:
   - **Request headers**: `x-ai-fleet-api-docs` = `enabled`
   - **Domain**: `api.aifleet.com` (or your production domain)
4. Enable the rule and visit: `https://api.aifleet.com/api/docs`

## Implementation Details

### Files

| File | Purpose |
|------|---------|
| `swagger.json` | OpenAPI 3.0 specification (auto-generated docs) |
| `src/swagger.js` | Swagger UI middleware + gating logic |
| `src/index.js` | Routes registration |
| `package.json` | Added `swagger-ui-express` dependency |

### Routes

| Route | Access | Purpose |
|-------|--------|---------|
| `GET /api/docs` | Gated by header in production | Interactive Swagger UI |
| `GET /swagger.json` | Gated by header in production | OpenAPI spec JSON |

### Gating Logic

```javascript
// In src/swagger.js
const IS_CLOUD = CONFIG.MESSAGING_MODE === 'pubsub';

function isApiDocsEnabled(req) {
  if (!IS_CLOUD) return true;  // Dev: always allow
  // Cloud: require header
  return req.get('x-ai-fleet-api-docs')?.trim() !== '';
}
```

- **Dev** (`MESSAGING_MODE !== 'pubsub'`): Always accessible, no header needed
- **Cloud** (`MESSAGING_MODE === 'pubsub'`): Returns 404 without `x-ai-fleet-api-docs` header

### Header Name

- **Constant**: `API_DOCS_HEADER = 'x-ai-fleet-api-docs'`
- **Value Required**: Any non-empty string (e.g., `enabled`, `1`, `true`, `yes`)
- **Case**: Lowercase (HTTP headers are case-insensitive, normalized to lowercase)

## Usage

### Accessing Docs

**Local**:
```bash
curl http://localhost:4000/swagger.json
open http://localhost:4000/api/docs  # macOS
```

**Production** (with header):
```bash
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json
```

### Testing Endpoints

1. Open Swagger UI at `/api/docs`
2. Click **Authorize** button
3. Paste your Firebase ID token
4. Use **Try it out** on any endpoint

## Monitoring & Alerts

### Log What?

In production, log gated doc requests:

```javascript
// Gateway access log
[INFO] GET /api/docs?token=xyz 404 (docs_not_available) client=10.20.30.40
[INFO] GET /api/docs x-ai-fleet-api-docs=enabled 200 client=10.20.30.40
```

### Alert Triggers

- **High 404 rate to `/api/docs`**: May indicate bot scanning
- **Traffic spike to `/swagger.json`**: Could be legitimate team testing or automated crawling

## Configuration

### Disabling/Customizing

Edit `src/swagger.js`:

```javascript
// Change header name
const API_DOCS_HEADER = 'x-custom-docs-token';

// Add custom styling
customCss: `.swagger-ui { background: #f5f5f5; }`
```

Then redeploy.

## Security Considerations

### Not a True Authentication Boundary

The header gate is a **shared secret**, not cryptographic auth:

- ✅ Prevents casual discovery by bots/scanners
- ✅ Low friction for team tooling and testing
- ❌ Not suitable for sensitive environments (anyone with the header can access)

### Threat Models Protected Against

1. **Automated Scanning**: Port scanners, Shodan crawlers, bots
2. **Casual Enumeration**: Manual API exploration without prior knowledge
3. **Information Leakage**: Prevents endpoint discovery via public docs

### Threat Models NOT Protected Against

1. **Targeted Attacks**: Insider threats, leaked credentials, social engineering
2. **Cryptographic Validation**: Header is not signed or time-based
3. **Identity Enforcement**: No way to audit *who* accessed docs

## Deployment Checklist

- [ ] `swagger-ui-express` added to `package.json`
- [ ] `src/swagger.js` created with gating logic
- [ ] `swagger.json` committed and up-to-date
- [ ] Routes mounted in `src/index.js`
- [ ] Tests pass: `npm test`
- [ ] Local dev tested: `npm start` → open `http://localhost:4000/api/docs`
- [ ] Docs link shared with team (with ModHeader instructions for prod)
- [ ] Monitoring/alerting configured for 404s to `/api/docs`
- [ ] Header name documented in runbooks

## Testing

### Unit Tests

```bash
npm test -- src/swagger.test.js
```

### Integration Test

**Local**:
```bash
npm start
curl -I http://localhost:4000/api/docs  # Should return 200
curl -I http://localhost:4000/swagger.json  # Should return 200
```

**Cloud** (from CI or local with `MESSAGING_MODE=pubsub`):
```bash
# Without header — should fail
curl -I https://api.aifleet.com/api/docs  # Returns 404

# With header — should succeed
curl -I -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs  # Returns 200
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "API documentation is not available" in prod | Missing header | Add `x-ai-fleet-api-docs: enabled` |
| 404 on `/api/docs` in dev | Wrong build/branch | Verify `npm start` runs from this branch |
| Swagger UI loads but no endpoints | Spec fetch failed | Check `/swagger.json` is accessible with header |
| "Try it out" fails with 401 | Invalid/expired token | Get fresh Firebase token, re-authorize |

## Related Docs

- [SWAGGER_API_DOCS.md](../../docs/SWAGGER_API_DOCS.md) — Full documentation
- [index.js](./src/index.js) — Route registration
- [swagger.js](./src/swagger.js) — Middleware implementation

## Maintenance

### Updating the OpenAPI Spec

Edit `swagger.json` directly to:
- Add new endpoints
- Update request/response schemas
- Revise descriptions
- Adjust tags and grouping

**No code deployment required** — just update the JSON file.

### Rotating the Header Secret

1. Edit `swagger.js`: Change `API_DOCS_HEADER` constant
2. Redeploy gateway
3. Update team docs and ModHeader rules
4. Announce in team channels

Example:
```javascript
// Before
const API_DOCS_HEADER = 'x-ai-fleet-api-docs';

// After
const API_DOCS_HEADER = 'x-ai-fleet-docs-2024-09';  // Dated for tracking
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-08-24 | Initial Swagger setup with production gating |

## Support

For issues:
1. Check [Troubleshooting](#troubleshooting) above
2. Review [SWAGGER_API_DOCS.md](../../docs/SWAGGER_API_DOCS.md) full guide
3. Test locally first (`npm start` → `/api/docs`)
4. Verify header is being sent in production (curl/ModHeader)
