# Swagger API Documentation — Gateway Service

## Overview

The AI Fleet Gateway exposes OpenAPI 3.0 documentation via Swagger UI for interactive API exploration and testing. Access varies by deployment mode:

- **Local Development**: Always available, no authentication required
- **Cloud Production**: Requires an explicit request header for security

## URLs

### Local Development

- **Interactive Docs**: `http://localhost:4000/api/docs`
- **OpenAPI Spec (JSON)**: `http://localhost:4000/swagger.json`

No authentication or special headers required.

### Cloud Production

**Requires Header**: `x-ai-fleet-api-docs: enabled` (or any non-empty value)

- **Interactive Docs**: `https://api.aifleet.com/api/docs`
- **OpenAPI Spec (JSON)**: `https://api.aifleet.com/swagger.json`

**Without the header**: Both endpoints return `404 Not Found` with response:
```json
{
  "error": "API documentation is not available.",
  "code": "docs_not_available"
}
```

## Accessing Docs in Production

### Using ModHeader Browser Extension

The recommended way to access production docs is via the [ModHeader](https://modheader.com/) browser extension:

1. **Install ModHeader** from your browser's extension store
2. **Create a new rule** with these settings:
   - **Request headers**: Add header
   - **Name**: `x-ai-fleet-api-docs`
   - **Value**: `enabled` (or any value, including `1`, `true`, `yes`)
3. **Enable for domain**: `https://api.aifleet.com`
4. **Navigate to**: `https://api.aifleet.com/api/docs`

### Using curl

```bash
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs
```

### Using Postman

1. Open a new request to `https://api.aifleet.com/api/docs`
2. Go to **Headers** tab
3. Add header:
   - **Key**: `x-ai-fleet-api-docs`
   - **Value**: `enabled`
4. Send the request

### Using JavaScript/fetch

```javascript
fetch('https://api.aifleet.com/swagger.json', {
  headers: {
    'x-ai-fleet-api-docs': 'enabled'
  }
})
  .then(res => res.json())
  .then(spec => console.log(spec))
```

## Security Rationale

### Why Gate in Production?

The production Cloud Run gateway is exposed to the public internet. Without gating:

1. **Information Disclosure**: API endpoints, request/response schemas, and service structure become discoverable via automated scanning
2. **Enumeration Attacks**: Attackers can discover all endpoints and attempt to exploit them
3. **Social Engineering**: Complete API documentation makes it easier to craft convincing phishing or impersonation attacks
4. **Resource Waste**: Public docs trigger automated crawling by bots, increasing Cloud Run CPU costs

### Why Not Require Authentication?

1. **Bearer-Token Forwarding Complexity**: The browser-supplied Firebase JWT cannot be reliably injected into static HTML served by `swagger-ui-express`
2. **SPA Load Complexity**: Serving docs as part of the SPA would couple authentication state to documentation (complicates caching, versioning)
3. **Dev Parity**: Local dev should be fully open for testing; requiring authentication breaks this
4. **Simple Secret**: A shared request header is easier to distribute to a team than user account creation

### The Header as a "Shared Secret"

The `x-ai-fleet-api-docs` header acts as a **shared secret**, not true authentication:

- ✅ Blocks casual discovery by bots, port scanners, and automated crawlers
- ✅ Low friction for internal tooling, testing, and monitoring
- ✅ Can be rotated by changing deployment env (future: tie to API gateway secrets)
- ❌ NOT a security boundary (not cryptographic, not time-based, doesn't authenticate identity)

**Threat Model**: Protects against **opportunistic** attacks (scanning, enumeration), not **targeted** attacks (social engineering, leaked credentials, insider threats).

## OpenAPI Specification

### Version

- **OpenAPI**: 3.0.0
- **Info**: AI Fleet Gateway API v1.0.0

### Servers

| Environment | URL |
|-------------|-----|
| Local Dev | `http://localhost:4000` |
| Production | `https://api.aifleet.com` |

### Endpoints (Tagged)

| Tag | Endpoint | Purpose |
|-----|----------|---------|
| **Health** | `GET /healthz` | Service liveness probe |
| **Authentication** | `GET /api/auth/config` | Public Firebase config |
| | `GET /api/auth/me` | Current user identity |
| **Configuration** | `GET /api/config` | Deployment resolver |
| **Streaming** | `GET /api/agent/stream` | Conversation SSE stream |
| | `GET /api/agent/workspace-stream` | Workspace SSE stream |
| | `GET /api/agent/stream-token` | Mint conversation token |
| | `GET /api/agent/workspace-stream-token` | Mint workspace token |
| **EULA** | `GET /api/eula` | Check acceptance status |
| | `POST /api/eula` | Record acceptance |
| **Billing** | `GET /api/billing` | Organization costs |
| **Pipeline** | `POST /api/pipeline/start` | Start planner/coder run |
| **Knowledge** | `POST /api/agent/knowledge-search` | RAG search (public) |
| **Agent** | `POST /api/agent/business/prepare` | 6-stage business prep |
| | `POST /api/agent/conversations/:id/attachments` | Upload attachments |
| | `POST /api/agent/conversations/:id/attachments/ask` | LLM analysis |
| **Conversations** | `GET /api/agent/conversations` | List all conversations |
| **Organization** | `GET /api/org/me` | Personal workspace |

### Authentication

Most endpoints secured via **Bearer token** (Firebase ID token):

```
Authorization: Bearer <firebase-id-token>
```

Public endpoints (no Bearer required):
- `GET /healthz`
- `GET /api/auth/config`
- `GET /api/eula` (GET only; POST requires auth)
- `POST /api/agent/knowledge-search`
- SSE streams (`/api/agent/stream`, `/api/agent/workspace-stream`) — use signed stream tokens instead

## Development Workflow

### Testing Endpoints in Swagger UI

1. **Navigate to**: `http://localhost:4000/api/docs`
2. **Authorize** (if endpoint requires Bearer):
   - Click the **Authorize** button (top-right)
   - Paste your Firebase ID token
   - Click **Authorize**
3. **Try it out**:
   - Expand an endpoint
   - Click **Try it out**
   - Fill in parameters/request body
   - Click **Execute**
   - View response in the panel below

### Getting a Firebase Token for Testing

In the browser console (logged in to the dev app):

```javascript
firebase.auth().currentUser.getIdToken().then(token => {
  console.log('Token:', token);
  // Paste into Swagger's Authorize dialog
});
```

## Configuration

### Environment Variables

| Variable | Default | Cloud | Description |
|----------|---------|-------|-------------|
| `MESSAGING_MODE` | `'local'` | `'pubsub'` | Determines if gating is active |
| `API_DOCS_HEADER` | `x-ai-fleet-api-docs` | — | Header name (non-configurable, hardcoded) |

### Behavior

| Scenario | Docs Available? | Requires Header? |
|----------|-----------------|------------------|
| `MESSAGING_MODE !== 'pubsub'` (dev) | ✅ Yes | ❌ No |
| `MESSAGING_MODE === 'pubsub'` (cloud) | ✅ Yes | ✅ Yes (`x-ai-fleet-api-docs: *`) |

## Monitoring and Logging

### Gated Requests

When `/api/docs` or `/swagger.json` is accessed **without** the required header in production:

- **Response**: 404 Not Found
- **Body**: `{ "error": "API documentation is not available.", "code": "docs_not_available" }`
- **Logging**: Logged as a normal 404 (no special flag needed)

### Production Alerts

Consider monitoring for:

1. **Repeated 404s to `/api/docs`**: May indicate automated discovery attempts
2. **Traffic spikes to `/swagger.json`**: Could be bot scanning (expected during deployments)
3. **Valid requests WITH header**: Legitimate tooling or team testing

## Customization

### Changing the Header Name

Edit `services/gateway/src/swagger.js`:

```javascript
const API_DOCS_HEADER = 'x-ai-fleet-api-docs';  // Change this
```

Requires:
1. Code change + redeploy
2. Update team docs / runbooks
3. Coordinate with monitoring/alerting rules

### Disabling Docs in Production

To disable even with the header, set environment variable (future enhancement):

```bash
DISABLE_API_DOCS=true  # (not yet implemented)
```

### Custom Styling or Branding

Modify `createSwaggerUISetup()` in `swagger.js`:

```javascript
customCss: `
  .swagger-ui .topbar { display: none }
  .swagger-ui .info .title { color: #1f1f1f; }
`
```

## Troubleshooting

### "API documentation is not available" in Production

**Cause**: Missing or invalid header.

**Fix**:
```bash
# Verify the header is being sent
curl -v -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs

# Check response headers
curl -I -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs
```

### Swagger UI Loads But Endpoints Show "Loading Error"

**Cause**: CORS issue with the OpenAPI spec fetch.

**Fix**:
1. Ensure `/swagger.json` endpoint is accessible with the header
2. Check browser console for CORS errors
3. Verify `CORS_ORIGINS` includes the docs domain

### "Try it out" Returns 401 Unauthorized

**Cause**: Bearer token expired or malformed.

**Fix**:
1. Refresh the token via Firebase console
2. Re-enter it in the Authorize dialog
3. Clear browser cache if token was cached

## Related Documentation

- [REQUEST_FLOW_DIAGRAM.md](./REQUEST_FLOW_DIAGRAM.md) — Gateway request routing
- [GCP_DEPLOY.md](./GCP_DEPLOY.md) — Production deployment details
- [DEVELOPER_ONBOARDING.md](./DEVELOPER_ONBOARDING.md) — Local dev setup

## Quick Reference

| Use Case | Command/URL |
|----------|-------------|
| **Local dev docs** | Open `http://localhost:4000/api/docs` |
| **Get spec locally** | `curl http://localhost:4000/swagger.json` |
| **Get spec in prod** | `curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json` |
| **Test endpoint locally** | Use Swagger UI **Try it out** |
| **Test endpoint in prod** | Use ModHeader + Swagger UI, or `curl` with Bearer + header |
| **Rotate header** | Edit `swagger.js`, redeploy, notify team |

## Future Enhancements

Potential improvements (not yet implemented):

1. **Time-based token** (HMAC + timestamp) instead of static header
2. **Per-role gating** (admin/dev can see docs, others can't)
3. **Rate limiting** on docs endpoints
4. **Audit logging** of who accessed docs (IP, timestamp, success/failure)
5. **Docs download** as OpenAPI/Postman JSON for offline use
6. **API key support** for programmatic spec fetching (CI/CD, code generation)
