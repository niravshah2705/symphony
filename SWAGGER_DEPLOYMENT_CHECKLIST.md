# Swagger API Docs — Deployment Checklist

**Before deploying to production, verify everything on this list.**

---

## Pre-Deployment Verification (Dev Environment)

### Code Changes
- [ ] `services/gateway/package.json` — Added `swagger-ui-express` dependency
- [ ] `services/gateway/swagger.json` — OpenAPI spec created and valid
- [ ] `services/gateway/src/swagger.js` — Gating middleware implemented
- [ ] `services/gateway/src/index.js` — Routes mounted (`/api/docs` and `/swagger.json`)
- [ ] `services/gateway/src/swagger.test.js` — Unit tests created

### Local Testing
- [ ] `npm install` succeeds (swagger-ui-express installed)
- [ ] `npm test` passes (all tests green)
- [ ] `npm start` runs without errors
- [ ] Browser: `http://localhost:4000/api/docs` loads and renders
- [ ] Browser: `http://localhost:4000/swagger.json` returns valid JSON
- [ ] Swagger UI: Endpoints visible and searchable
- [ ] Swagger UI: Schema tabs show request/response formats
- [ ] Swagger UI: Error codes documented

### Documentation
- [ ] [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md) — Complete reference created
- [ ] [SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md) — Technical guide created
- [ ] [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md) — Role-based runbook created
- [ ] [SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md) — Full summary created
- [ ] [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) — Quick reference created
- [ ] README updated with link to `/api/docs`

### Security Review
- [ ] `swagger.json` reviewed — no hardcoded secrets
- [ ] `swagger.json` reviewed — no internal IPs or domains exposed
- [ ] `swagger.json` reviewed — error messages don't leak sensitive info
- [ ] Header name finalized: `x-ai-fleet-api-docs` (or team-approved name)
- [ ] Security team reviewed gating model
- [ ] Rate limiting discussed (if needed)

### Configuration
- [ ] Header constant matches deployment config
- [ ] `MESSAGING_MODE` variable understood (determines gating)
- [ ] No hardcoded URLs (uses relative paths)
- [ ] No hardcoded environment-specific values

---

## Deployment Steps (Staging/Production)

### Build & Package
- [ ] Clean build: `npm ci` (not `npm install`)
- [ ] Build succeeds: `npm run build` (if applicable)
- [ ] No warnings or errors in build output
- [ ] Docker image builds successfully (if containerized)
- [ ] All dependencies resolved correctly

### Environment Configuration
- [ ] `MESSAGING_MODE=pubsub` set (for cloud production)
- [ ] `NODE_ENV=production` set
- [ ] All required secrets mounted (Firebase config, etc.)
- [ ] No localhost URLs in production config

### Deploy to Staging
- [ ] `gcloud run deploy` or equivalent succeeds
- [ ] Service health checks pass
- [ ] No startup errors in logs
- [ ] Deployed service is reachable

### Staging Verification
- [ ] **Without header**: `curl https://staging-gateway/api/docs` → 404 ✅
- [ ] **With header**: `curl -H "x-ai-fleet-api-docs: enabled" https://staging-gateway/api/docs` → 200 ✅
- [ ] **Spec endpoint**: `curl -H "x-ai-fleet-api-docs: enabled" https://staging-gateway/swagger.json` → Valid JSON ✅
- [ ] Browser: Open with ModHeader → docs render ✅
- [ ] Browser console: No CORS errors ✅
- [ ] Swagger UI: "Try it out" works with Bearer token ✅

### Test Critical Paths
- [ ] Health check: `GET /healthz` → 200 ✅
- [ ] Auth config: `GET /api/auth/config` → 200 ✅
- [ ] Auth status: `GET /api/auth/me` (no auth) → 401 ✅
- [ ] Auth status: `GET /api/auth/me` (with Bearer) → 200 ✅

### Production Deployment
- [ ] Staging tests passed
- [ ] Change log written (for team/support)
- [ ] Deployment window scheduled (if required)
- [ ] Rollback plan ready
- [ ] `gcloud run deploy` to production
- [ ] Verify service is healthy

### Production Verification
- [ ] **Without header**: `curl https://api.aifleet.com/api/docs` → 404 ✅
- [ ] **With header**: `curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs` → 200 ✅
- [ ] **Spec endpoint**: `curl -s -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json | jq .` → Valid ✅
- [ ] **Monitoring**: CloudRun metrics visible ✅
- [ ] **Logging**: Requests visible in Cloud Logging ✅

---

## Post-Deployment

### Team Notification
- [ ] Team notified of new docs endpoint
- [ ] Team provided with:
  - [ ] URL: `https://api.aifleet.com/api/docs`
  - [ ] ModHeader setup instructions
  - [ ] Bearer token retrieval instructions
  - [ ] Troubleshooting guide
- [ ] Link added to team wiki/Slack
- [ ] Link added to README
- [ ] Link added to onboarding docs

### Monitoring & Alerting
- [ ] CloudRun dashboard shows the new endpoints
- [ ] Logs are flowing to Cloud Logging
- [ ] Alert configured: High 404 rate to `/api/docs` (>10 per 5 min)
- [ ] Alert configured: `/swagger.json` fetch failures
- [ ] Dashboard created: API docs access pattern
- [ ] On-call team knows to check new alerts

### Team Training
- [ ] Frontend devs trained on ModHeader
- [ ] QA engineers know how to import to Postman
- [ ] Backend devs know `curl` approach
- [ ] DevOps team knows monitoring approach
- [ ] Security team has audit access

### Documentation Updates
- [ ] README links to `/api/docs`
- [ ] Onboarding guide mentions Swagger docs
- [ ] Runbooks updated with "API docs access" section
- [ ] Support FAQ includes troubleshooting
- [ ] Architecture docs reference OpenAPI spec

### Feedback Loop
- [ ] Team can report issues/improvements
- [ ] Feedback channel established (Slack thread, GitHub issue, etc.)
- [ ] Owner assigned for maintaining the docs
- [ ] Maintenance schedule defined (e.g., update spec with each API change)

---

## Success Metrics

After deployment, validate:

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Docs accessible locally (dev) | 100% | — | ⬜ |
| Docs return 404 without header (prod) | 100% | — | ⬜ |
| Docs accessible with header (prod) | 100% | — | ⬜ |
| Spec is valid JSON | 100% | — | ⬜ |
| UI loads without JS errors | 100% | — | ⬜ |
| "Try it out" works | 100% | — | ⬜ |
| No security warnings in spec | 100% | — | ⬜ |
| Team can access (with header) | 100% | — | ⬜ |
| Monitoring alerts working | 100% | — | ⬜ |
| Documentation complete | 100% | — | ⬜ |

---

## Rollback Plan

If issues occur post-deployment:

### Quick Rollback (minutes)
1. Revert code changes to previous gateway version
2. Redeploy previous known-good image
3. Verify `/api/docs` responds with 404 (gating disabled)
4. Alert team of temporary service disruption

### Long Rollback (if needed)
1. Disable in Cloud Run env vars: `DISABLE_API_DOCS=true` (if implemented)
2. Or: Remove routes from `index.js`, redeploy
3. Or: Downgrade swagger-ui-express in package.json

### Testing After Rollback
- [ ] Docs endpoint returns 404 or not found
- [ ] No errors in gateway logs
- [ ] Other endpoints still work normally
- [ ] Team notified

---

## Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| Spec is invalid JSON | Syntax error in `swagger.json` | Validate with `jq` before deploying |
| Routes not mounted | Missing import or app.use() | Check `src/index.js` has all 3 lines |
| Header not checked | MESSAGING_MODE not set | Verify `MESSAGING_MODE=pubsub` in prod |
| CORS errors | Spec fetch headers missing | Check createApiDocsGate() is applied |
| 404 without header (dev) | Bug in gating logic | Check CONFIG.MESSAGING_MODE |
| 200 with wrong header (prod) | Header validation too loose | Check header parsing trims whitespace |

---

## Sign-Off

- [ ] **Developer**: Code complete, tested, reviewed
  - Name: _________________ Date: _______
  
- [ ] **QA**: All tests passing, staging verified
  - Name: _________________ Date: _______
  
- [ ] **Ops/SRE**: Infrastructure ready, monitoring configured
  - Name: _________________ Date: _______
  
- [ ] **Security**: Spec reviewed, gating validated
  - Name: _________________ Date: _______
  
- [ ] **Tech Lead**: Approve for production
  - Name: _________________ Date: _______

---

## Notes for This Deployment

```
[Space for notes/blockers/decisions]




```

---

## Post-Deployment Follow-Up

### 24 Hours After Deployment
- [ ] No unexpected errors in logs
- [ ] Alert thresholds appropriate (adjust if needed)
- [ ] Team feedback (collected via Slack/GitHub)

### 1 Week After Deployment
- [ ] Docs usage metrics (how many hits to `/api/docs`)
- [ ] Feedback incorporation (any spec updates needed?)
- [ ] Monitoring baseline established

### 1 Month After Deployment
- [ ] Usage patterns stable
- [ ] No security incidents
- [ ] Team satisfaction survey
- [ ] Next enhancement planning (e.g., API versioning)

---

**Deployment Date**: ______________  
**Deployed By**: ______________  
**Approved By**: ______________  
**Rollback By (if needed)**: ______________

---

See [SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md) for full context.
