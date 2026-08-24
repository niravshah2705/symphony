# Swagger API Docs — Quick Reference Card

**Print this or bookmark it!**

---

## TL;DR

| Scenario | Action | Result |
|----------|--------|--------|
| **Local Dev** | Open `http://localhost:4000/api/docs` | 📖 Interactive API docs |
| **Production** | Install [ModHeader](https://modheader.com/), add `x-ai-fleet-api-docs: enabled`, visit `https://api.aifleet.com/api/docs` | 📖 Interactive API docs |
| **curl (prod)** | `curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json` | 📄 OpenAPI spec (JSON) |
| **Postman (prod)** | Import spec, add header in collection settings | 📮 Test endpoints |

---

## Local Development Setup

```bash
npm start
# Open browser: http://localhost:4000/api/docs
# No auth, no headers required
```

---

## Production Setup

### Option 1: ModHeader (Browser)

1. Install [ModHeader](https://modheader.com/) extension
2. Create rule:
   - Name: `x-ai-fleet-api-docs`
   - Value: `enabled`
   - Domain: `api.aifleet.com`
3. Open `https://api.aifleet.com/api/docs`

### Option 2: curl

```bash
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs
```

### Option 3: Postman

1. Import spec: `https://api.aifleet.com/swagger.json`
2. Add header to collection:
   - `x-ai-fleet-api-docs: enabled`
3. Set auth: **Bearer Token** = `<firebase-token>`

---

## API Endpoints Overview

| Category | Endpoints |
|----------|-----------|
| **Auth** | `GET /api/auth/config`, `GET /api/auth/me` |
| **Health** | `GET /healthz` |
| **Config** | `GET /api/config` |
| **Streaming** | `GET /api/agent/stream*`, `GET /api/agent/workspace-stream*` |
| **Pipeline** | `POST /api/pipeline/start` |
| **Billing** | `GET /api/billing` |
| **Knowledge** | `POST /api/agent/knowledge-search` |
| **Organization** | `GET /api/org/me` |
| **Conversations** | `GET /api/agent/conversations` |
| **EULA** | `GET /api/eula`, `POST /api/eula` |

**Full list**: See `/api/docs` or `swagger.json`

---

## Getting a Bearer Token (for testing)

### In Browser Console (while logged in)

```javascript
firebase.auth().currentUser.getIdToken().then(token => {
  console.log(token);
  // Copy and paste into Swagger UI Authorize dialog
});
```

### In Postman

1. Create env var: `BEARER_TOKEN`
2. Set value to your Firebase ID token
3. In request auth: Select **Bearer Token** → `{{BEARER_TOKEN}}`

---

## Header Details

| Key | Value | Required? | Example |
|-----|-------|-----------|---------|
| `x-ai-fleet-api-docs` | Any non-empty string | In production only | `enabled`, `true`, `1`, `yes` |

**In Local Dev**: Header is ignored (docs always accessible)  
**In Production** (cloud): Header is required (returns 404 without it)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "API documentation is not available" (prod) | Add header: `-H "x-ai-fleet-api-docs: enabled"` |
| Swagger loads but "Loading Error" | Check that `/swagger.json` request includes header |
| "Try it out" returns 401 | Get fresh Firebase token, click Authorize, paste token |
| ModHeader rule not working | Verify rule is ON, domain is `api.aifleet.com` (not https://), reload page |

---

## Documentation Files

| File | For | Use When |
|------|-----|----------|
| **SWAGGER_TEAM_RUNBOOK.md** | All roles | You want role-specific setup (Frontend, QA, DevOps, etc.) |
| **SWAGGER_API_DOCS.md** | Reference | You need full details (security, monitoring, config, etc.) |
| **SWAGGER_SETUP.md** | Technical | You're implementing or debugging the gateway |
| **SWAGGER_IMPLEMENTATION_SUMMARY.md** | Maintainers | You're deploying or updating the setup |

---

## Key URLs

| Environment | URL | Notes |
|-------------|-----|-------|
| **Local Dev** | `http://localhost:4000/api/docs` | Always accessible |
| | `http://localhost:4000/swagger.json` | Always accessible |
| **Production** | `https://api.aifleet.com/api/docs` | Requires `x-ai-fleet-api-docs` header |
| | `https://api.aifleet.com/swagger.json` | Requires `x-ai-fleet-api-docs` header |

---

## Security Model

🔒 **What's Protected**:
- ✅ Endpoint list (not exposed without header)
- ✅ Request/response schemas (not exposed without header)
- ✅ Service structure (not exposed without header)

🚫 **What's NOT Protected**:
- ❌ Signature validation (header is not signed)
- ❌ Time-based expiration (header doesn't expire)
- ❌ Identity audit (no log of *who* accessed)

**Summary**: Header acts as a **shared team secret**, not cryptographic auth. Prevents casual discovery by bots, but anyone with the header can access. Treat like a WiFi password.

---

## For Each Role

### 👨‍💻 Frontend Developers

```
1. Install ModHeader
2. Add rule: x-ai-fleet-api-docs = enabled for api.aifleet.com
3. Visit https://api.aifleet.com/api/docs
4. Get Bearer token from console: firebase.auth().currentUser.getIdToken()
5. Click Authorize → paste token
6. Use Try it out on any endpoint
```

### 🔧 Backend Developers

```
# Get spec
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json | jq .

# Download for code gen
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json > openapi.json

# Generate client code
openapi-generator generate -i openapi.json -g go -o ./api-client
```

### 🧪 QA Engineers

```
1. Import spec into Postman: https://api.aifleet.com/swagger.json
2. Add header in collection settings: x-ai-fleet-api-docs = enabled
3. Create env var: BEARER_TOKEN = <your-firebase-token>
4. Test endpoints with Try
```

### 🚀 DevOps/SRE

```bash
# Verify deployment
curl -f -H "x-ai-fleet-api-docs: enabled" \
     https://api.aifleet.com/api/docs > /dev/null && echo "✅" || echo "❌"

# Monitor 404 rate (should be low in prod, high during scanning)
gcloud logging read "path=/api/docs AND status=404" --limit 50
```

---

## Changing the Header (Future)

If you need to rotate the header secret:

1. Edit: `services/gateway/src/swagger.js` → Line: `const API_DOCS_HEADER = '...'`
2. Change value (e.g., to `x-ai-fleet-docs-2024-09`)
3. Redeploy gateway
4. Notify team to update ModHeader rules
5. Update this document

---

## Common Requests

### "I can't access the docs in production"

**A**: You need the header. Use:
- **Browser**: Install ModHeader, create rule with `x-ai-fleet-api-docs: enabled`
- **curl**: Add `-H "x-ai-fleet-api-docs: enabled"`
- **Postman**: Add header to collection settings

### "Why do we need a header? Why not just use auth?"

**A**: The header is a simple shared secret for the team. Full Firebase auth would:
- Require every request to carry a user token (complex)
- Couple authentication state to static docs (caching nightmare)
- Be overkill for reference material (not data)

The header strikes a balance: blocks bots, low friction for team tooling.

### "What if the header is leaked?"

**A**: Anyone with it can view API structure. This is **information disclosure**, not a data breach. The docs don't contain secrets or data — just endpoint descriptions. Still treat it like a team secret. If leaked:
1. Rotate the header (edit code, redeploy)
2. Notify the team
3. Review access logs

### "Can I share the header with a client/partner?"

**A**: Not recommended. The header is for internal team use. For external partners:
- Option 1: Deploy a separate public docs server
- Option 2: Provide Postman collection via email
- Option 3: Create a separate docs route (authenticated endpoint)

---

## One-Line Summary

**🚀 Local**: `npm start` → visit `http://localhost:4000/api/docs`  
**🔒 Production**: Add header `x-ai-fleet-api-docs: enabled` (via ModHeader or curl) → visit `https://api.aifleet.com/api/docs`

---

## Need More Help?

- **Setup issue?** → [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#troubleshooting)
- **Technical details?** → [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md)
- **How it's implemented?** → [SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md)
- **Full context?** → [SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md)

---

**Last Updated**: 2026-08-24  
**Questions?** Check the docs above or ask your team 👍
