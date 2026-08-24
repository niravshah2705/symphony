# Team Runbook — API Docs Access in Production

**Quick Answer**: Use the [ModHeader](https://modheaker.com/) browser extension with `x-ai-fleet-api-docs: enabled` to access `/api/docs` in production.

---

## By Role

### Frontend Developers

**Goal**: Test API endpoints, check request/response schemas, debug integration issues

**Setup** (one-time, 5 min):

1. Install [ModHeader](https://modheader.com/) browser extension
2. Click extension icon → **Create New Rule**
3. Fill in:
   - **Profile Name**: `API Fleet Docs` (or any name)
   - **Request headers → Add**:
     - **Name**: `x-ai-fleet-api-docs`
     - **Value**: `enabled`
   - **Domain**: `api.aifleet.com` (or your prod domain)
4. Toggle rule **ON**
5. Visit: `https://api.aifleet.com/api/docs`

**Common Tasks**:

| Task | Steps |
|------|-------|
| **Check endpoint schema** | Search endpoint in Swagger → click **Schema** tab |
| **Test an endpoint** | Click **Try it out** → fill params → click **Execute** |
| **Get auth token** | Open browser console, run `firebase.auth().currentUser.getIdToken()` |
| **Copy spec to Postman** | Copy `/swagger.json` content → Postman **Import** → Paste Raw |

---

### Backend/API Developers

**Goal**: Review API contracts, debug integrations, validate spec accuracy

**Setup** (one-time, 2 min):

```bash
# Add to your .bashrc / .zshrc / env
export API_DOCS_TOKEN="enabled"
export PROD_API="https://api.aifleet.com"

# Helper function
api-docs() {
  curl -s -H "x-ai-fleet-api-docs: $API_DOCS_TOKEN" "$PROD_API/swagger.json" | jq .
}

# Or download the spec
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json > openapi.json
```

**Common Commands**:

```bash
# Get spec
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json | jq .

# Validate spec (requires go-swagger or openapi-generator)
swagger validate openapi.json

# Generate code from spec
openapi-generator generate -i openapi.json -g go -o ./api-client

# Check specific endpoint
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json | jq '.paths["/api/billing"]'

# Test endpoint with bearer token + auth header
TOKEN=$(firebase auth:export --format json | jq -r ...)
curl -H "Authorization: Bearer $TOKEN" \
     -H "x-ai-fleet-api-docs: enabled" \
     https://api.aifleet.com/api/billing
```

---

### DevOps / Platform Engineers

**Goal**: Monitor API health, trace requests, audit docs access

**Setup**:

1. **In deployment**:
   - Verify `MESSAGING_MODE=pubsub` (triggers gating)
   - Confirm `swagger.json` file is deployed
   - Test locally before cloud deploy

2. **Monitoring**:
   ```bash
   # Alert on high 404s to /api/docs (indicates scanning/probing)
   count(rate(http_request_total{path="/api/docs", status="404"}[5m])) > 10

   # Track successful docs access (with header)
   count(rate(http_request_total{path="/api/docs", status="200"}[1h]))
   ```

3. **Logs**:
   ```bash
   # Find docs access attempts
   gcloud logging read \
     "resource.type=cloud_run_revision AND jsonPayload.path=/api/docs" \
     --limit 50

   # Filter by header presence
   gcloud logging read \
     "jsonPayload.headers.x-ai-fleet-api-docs=enabled" \
     --limit 50
   ```

4. **Testing Production**:
   ```bash
   # Verify docs are accessible
   curl -f -H "x-ai-fleet-api-docs: enabled" \
        https://api.aifleet.com/api/docs > /dev/null && \
        echo "✅ Docs accessible" || \
        echo "❌ Docs NOT accessible"

   # Test spec endpoint
   curl -s -H "x-ai-fleet-api-docs: enabled" \
        https://api.aifleet.com/swagger.json | \
        jq '.info.title' && \
        echo "✅ Spec valid" || \
        echo "❌ Spec invalid"
   ```

---

### QA / Test Engineers

**Goal**: Validate API behavior, test edge cases, verify error handling

**Setup**:

**Option 1: Postman** (recommended for QA)

1. Download [Postman](https://www.postman.com/downloads/)
2. Get the spec:
   ```bash
   curl -H "x-ai-fleet-api-docs: enabled" \
        https://api.aifleet.com/swagger.json > openapi.json
   ```
3. Import into Postman:
   - Click **Import** → **Choose Files** → select `openapi.json`
   - Postman auto-generates a collection
4. Set up variables:
   - Click **Environment** → **New**
   - Add variables:
     - `base_url`: `https://api.aifleet.com`
     - `token`: `<your-firebase-id-token>`
     - `api_docs_header`: `enabled`
5. Update requests:
   - Add header: `x-ai-fleet-api-docs: {{api_docs_header}}`
   - Add auth: **Bearer Token** → `{{token}}`
6. Test!

**Option 2: curl** (for scripted testing)

```bash
#!/bin/bash
set -e

PROD_API="https://api.aifleet.com"
HEADER_TOKEN="enabled"
BEARER_TOKEN="<your-firebase-token>"

# Test endpoint
curl -X GET \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "x-ai-fleet-api-docs: $HEADER_TOKEN" \
  "$PROD_API/api/auth/me"
```

**Test Scenarios**:

| Scenario | Command | Expected |
|----------|---------|----------|
| Valid request + header | `curl -H "x-ai-fleet-api-docs: enabled" .../api/docs` | 200 OK |
| Missing header | `curl .../api/docs` | 404 Not Found |
| Invalid header value | `curl -H "x-ai-fleet-api-docs: invalid" .../api/docs` | 200 OK (any non-empty accepted) |
| Empty header value | `curl -H "x-ai-fleet-api-docs: " .../api/docs` | 404 Not Found |
| With Bearer token | `curl -H "Authorization: Bearer $TOKEN" .../api/docs` | 200 OK (header alone sufficient) |

---

### Security/Compliance

**Goal**: Audit docs access, ensure no unauthorized exposure, validate gating

**Checklist**:

- [ ] Verify docs **NOT** accessible without `x-ai-fleet-api-docs` header in production
  ```bash
  curl -s -o /dev/null -w "%{http_code}" https://api.aifleet.com/api/docs  # Should be 404
  ```

- [ ] Verify docs **ARE** accessible with header in production
  ```bash
  curl -s -o /dev/null -w "%{http_code}" \
       -H "x-ai-fleet-api-docs: enabled" \
       https://api.aifleet.com/api/docs  # Should be 200
  ```

- [ ] Review access logs for docs endpoints
  ```bash
  # High 404 rate = potential scanning attempt
  # Valid 200s with header = legitimate use
  gcloud logging read "resource.type=cloud_run_revision AND jsonPayload.path=/api/docs"
  ```

- [ ] Confirm spec doesn't expose sensitive endpoints
  ```bash
  curl -s -H "x-ai-fleet-api-docs: enabled" \
       https://api.aifleet.com/swagger.json | \
       jq '.paths | keys' | grep -i secret  # Should be empty
  ```

---

## Troubleshooting

### "API documentation is not available" (404)

**In Local Dev** (should NOT happen):
```bash
# Check MESSAGING_MODE
echo $MESSAGING_MODE  # Should be empty or 'local'

# Restart gateway
npm start
```

**In Production** (expected without header):
```bash
# Add the header
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs

# Verify header is sent
curl -v -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs 2>&1 | grep -i "x-ai-fleet"
```

### Swagger UI Loads but "Loading Error"

**Cause**: Spec fetch failed (header not sent to `/swagger.json`)

**Fix**:
1. Check DevTools → Network tab → `/swagger.json` request
2. Verify header is present in request
3. Check response status (should be 200)
4. Reload page

### "Try it out" Returns 401

**Cause**: Invalid or expired Bearer token

**Fix**:
1. Get a fresh token:
   ```javascript
   firebase.auth().currentUser.getIdToken().then(t => console.log(t))
   ```
2. Click **Authorize** in Swagger UI
3. Clear the old token, paste new one
4. Retry

### ModHeader Rule Not Working

**Fix**:
1. **Verify rule is ON**: Extension icon should show active rules
2. **Check domain match**: Rule domain must match current site
   - ✅ `api.aifleet.com`
   - ❌ `https://api.aifleet.com` (no protocol)
3. **Reload page**: `Cmd+R` / `Ctrl+R`
4. **Check incognito mode**: Extensions disabled by default (enable in settings)

---

## Access Control

| Who | Local Dev | Production |
|-----|-----------|-----------|
| Frontend devs | ✅ Open (no header) | ✅ With ModHeader |
| Backend devs | ✅ Open (no header) | ✅ With curl/scripts |
| QA engineers | ✅ Open (no header) | ✅ With Postman + header |
| DevOps/SRE | ✅ Open (no header) | ✅ With curl/monitoring |
| Security team | ✅ Open (no header) | ✅ Audit logs + header |
| External parties | ❌ N/A | ❌ No access (no header) |

---

## Frequently Asked Questions

**Q: Why do we need a header in production?**

A: Public API docs attract automated scanners and attackers. The header prevents casual discovery while remaining low-friction for internal tooling.

**Q: Can I share the header value with external partners?**

A: Not recommended. The header is a shared secret for the team. For external partners, either:
- Deploy a separate docs instance (e.g., public-docs.aifleet.com)
- Provide Postman collection via email/zip
- Host HTML docs behind a proper auth gateway

**Q: Is the header encrypted?**

A: No, it's transmitted in plaintext (like all HTTP headers). Use HTTPS to prevent interception.

**Q: Can I use a stronger auth method?**

A: Future enhancement could use time-based tokens (HMAC + timestamp), but that's complex. For now, the static header is acceptable and low-friction.

**Q: What if the header is leaked?**

A: Anyone with the header can access API docs. Since docs are reference material (not data), the risk is **information disclosure**, not **data breach**. Still, treat it like a shared team secret.

**Q: Can I change the header name?**

A: Yes, edit `services/gateway/src/swagger.js` and redeploy. Notify the team of the change.

**Q: Will docs work without internet?**

A: No, Swagger UI requires CDN assets. Workaround: Download the `openapi.json` spec and use local Swagger/Postman.

---

## More Help

- **Full documentation**: [SWAGGER_API_DOCS.md](./SWAGGER_API_DOCS.md)
- **Gateway setup**: [services/gateway/SWAGGER_SETUP.md](../services/gateway/SWAGGER_SETUP.md)
- **OpenAPI spec**: [services/gateway/swagger.json](../services/gateway/swagger.json)
- **Code reference**: [services/gateway/src/swagger.js](../services/gateway/src/swagger.js)

---

**Last Updated**: 2026-08-24  
**Maintained By**: Platform Team
