# Swagger API Documentation — Complete Index

**Master guide for all Swagger-related documentation and implementation.**

---

## Quick Navigation

### For Different Audiences

👤 **Choosing Your Document**:

| If You Are... | Start Here | Then Read |
|---------------|-----------|----------|
| **Frontend Developer** | [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) | [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#frontend-developers) |
| **Backend Developer** | [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) | [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#backendapi-developers) |
| **QA Engineer** | [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#qa--test-engineers) | [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md#development-workflow) |
| **DevOps/SRE** | [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#devops--platform-engineers) | [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md#monitoring-and-logging) |
| **Security/Compliance** | [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#securitycompliance) | [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md#security-rationale) |
| **Manager/Tech Lead** | [SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md) | [SWAGGER_DEPLOYMENT_CHECKLIST.md](SWAGGER_DEPLOYMENT_CHECKLIST.md) |
| **Maintaining Code** | [services/gateway/SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md) | [services/gateway/src/swagger.js](services/gateway/src/swagger.js) |

---

## Complete Documentation Map

### 📍 Start Here (5 min read)
- **[SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md)** — TL;DR for everyone
  - Local dev setup (one line)
  - Production setup (ModHeader/curl/Postman)
  - API endpoints overview
  - Troubleshooting quick-links

### 🚀 Getting Started (10 min read)
- **[SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md)** — Role-based quick-start
  - Frontend devs: ModHeader setup
  - Backend devs: curl/scripting approach
  - QA: Postman integration
  - DevOps: Monitoring & verification
  - Security: Audit procedures
  - FAQ section

### 📚 Complete Reference (20-30 min read)
- **[SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md)** — Full documentation
  - Overview & URLs
  - Access methods (all tools)
  - Security rationale (in-depth)
  - OpenAPI specification details
  - Development workflow
  - Configuration & monitoring
  - Troubleshooting guide
  - Future enhancements

### 🏗️ Implementation Details (Technical, 15 min read)
- **[SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md)** — How it's built
  - Files created
  - Routes & gating logic
  - Implementation code
  - Testing approach
  - Maintenance procedures

### 📋 Summary & Context (10 min read)
- **[SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md)** — Full picture
  - What was created
  - How it works (dev vs cloud)
  - Security model
  - Deployment checklist
  - Monitoring & alerts
  - Troubleshooting guide
  - Related docs & future enhancements

### ✅ Deployment Prep (20 min checklist)
- **[SWAGGER_DEPLOYMENT_CHECKLIST.md](SWAGGER_DEPLOYMENT_CHECKLIST.md)** — Pre/post deployment
  - Pre-deployment verification
  - Deployment steps
  - Post-deployment tasks
  - Rollback plan
  - Sign-off section

### 🔧 Source Code & Tests
- **[services/gateway/swagger.json](services/gateway/swagger.json)** — OpenAPI 3.0 spec
- **[services/gateway/src/swagger.js](services/gateway/src/swagger.js)** — Gating middleware
- **[services/gateway/src/swagger.test.js](services/gateway/src/swagger.test.js)** — Unit tests
- **[services/gateway/src/index.js](services/gateway/src/index.js)** — Route registration (line ~78-88)
- **[services/gateway/package.json](services/gateway/package.json)** — Dependencies (line ~17)

---

## Documentation by Topic

### 🌐 Access & Setup

| Document | Section | Use When |
|----------|---------|----------|
| QUICK_REFERENCE | TL;DR | You want the fastest possible setup |
| TEAM_RUNBOOK | All sections | You're setting up for the first time |
| API_DOCS | "Accessing Docs in Production" | You need instructions for a specific tool |
| API_DOCS | "Development Workflow" | You want to test endpoints |

### 🔐 Security & Gating

| Document | Section | Use When |
|----------|---------|----------|
| API_DOCS | "Security Rationale" | You want to understand why we gate |
| IMPLEMENTATION_SUMMARY | "Security Model" | You're evaluating the design |
| SETUP | "Code Changes" | You're implementing the solution |
| TEAM_RUNBOOK | "Security/Compliance" | You're doing an audit |

### 📊 Monitoring & Troubleshooting

| Document | Section | Use When |
|----------|---------|----------|
| API_DOCS | "Monitoring and Logging" | You're setting up alerts |
| TEAM_RUNBOOK | "Troubleshooting" | You're debugging an issue |
| QUICK_REFERENCE | "Troubleshooting" | You want a quick fix |
| IMPLEMENTATION_SUMMARY | "Monitoring & Alerts" | You're designing the dashboard |

### 🚀 Deployment & Operations

| Document | Section | Use When |
|----------|---------|----------|
| DEPLOYMENT_CHECKLIST | All | You're deploying to production |
| IMPLEMENTATION_SUMMARY | "Deployment Checklist" | You want overview before details |
| SETUP | "Testing" | You want to verify before deploy |
| API_DOCS | "Configuration" | You need to customize behavior |

### 🛠️ Development & Maintenance

| Document | Section | Use When |
|----------|---------|----------|
| SETUP | "Implementation Details" | You're maintaining the code |
| swagger.js | (file) | You're updating gating logic |
| swagger.json | (file) | You're adding/updating endpoints |
| SETUP | "Updating the OpenAPI Spec" | You're adding new routes |

---

## Key Files at a Glance

### Gateway Service Files

```
services/gateway/
├── package.json                 # ✏️ Added swagger-ui-express
├── swagger.json                 # 📄 OpenAPI 3.0 specification (NEW)
├── SWAGGER_SETUP.md             # 📖 Technical guide (NEW)
└── src/
    ├── index.js                 # ✏️ Routes added (~line 78-88)
    ├── swagger.js               # 🆕 Gating middleware
    └── swagger.test.js          # 🆕 Unit tests
```

### Documentation Files

```
./
├── SWAGGER_QUICK_REFERENCE.md       # 🆕 TL;DR (1 page)
├── SWAGGER_INDEX.md                 # 🆕 This file (roadmap)
└── SWAGGER_DEPLOYMENT_CHECKLIST.md  # 🆕 Pre/post-deploy

docs/
├── SWAGGER_API_DOCS.md              # 🆕 Complete guide (30 min read)
├── SWAGGER_TEAM_RUNBOOK.md          # 🆕 Role-based setup (10 min read)
└── SWAGGER_IMPLEMENTATION_SUMMARY.md # 🆕 Full context (15 min read)

services/gateway/
└── SWAGGER_SETUP.md                 # 🆕 Technical details (10 min read)
```

---

## Essential Facts

### URLs

| Scenario | URL | Requires Header? |
|----------|-----|------------------|
| Local dev (docs) | `http://localhost:4000/api/docs` | ❌ No |
| Local dev (spec) | `http://localhost:4000/swagger.json` | ❌ No |
| Production (docs) | `https://api.aifleet.com/api/docs` | ✅ Yes |
| Production (spec) | `https://api.aifleet.com/swagger.json` | ✅ Yes |

### Header

| Property | Value | Notes |
|----------|-------|-------|
| **Name** | `x-ai-fleet-api-docs` | HTTP header (case-insensitive) |
| **Value** | Any non-empty string | Examples: `enabled`, `1`, `true` |
| **Required** | Only in cloud/production | Dev: always ignored (docs accessible) |
| **Expiration** | Never | Static shared secret (no TTL) |

### Implementation

| Component | Location | Status |
|-----------|----------|--------|
| OpenAPI Spec | `services/gateway/swagger.json` | ✅ Created |
| Gating Logic | `services/gateway/src/swagger.js` | ✅ Implemented |
| Routes | `services/gateway/src/index.js` | ✅ Added |
| Dependency | `services/gateway/package.json` | ✅ Added |
| Tests | `services/gateway/src/swagger.test.js` | ✅ Created |
| Documentation | `docs/SWAGGER_*.md` | ✅ Created |

---

## Common Questions & Answers

### ❓ Setup Questions

**Q: How do I access the docs locally?**
A: Open `http://localhost:4000/api/docs` after running `npm start`. No auth needed.

**Q: How do I access the docs in production?**
A: Install ModHeader, create rule with `x-ai-fleet-api-docs: enabled`, visit `https://api.aifleet.com/api/docs`.

**Q: What's the fastest way to get started?**
A: Read [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) (5 min), then follow role-specific guide in [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md).

### 🔐 Security Questions

**Q: Why do we need a header in production?**
A: Prevents automated discovery by bots/scanners. Acts as a shared team secret (like a WiFi password).

**Q: Is the header encrypted?**
A: No, it's transmitted in plaintext. Use HTTPS (production is HTTPS) to prevent interception.

**Q: What if the header is leaked?**
A: Anyone with it can view API structure. This is **information disclosure** (not data breach). Rotate header immediately if leaked.

### 🚀 Deployment Questions

**Q: When can we deploy to production?**
A: After completing [SWAGGER_DEPLOYMENT_CHECKLIST.md](SWAGGER_DEPLOYMENT_CHECKLIST.md) pre-deployment section.

**Q: How do we monitor in production?**
A: Check [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md#monitoring-and-logging) for alerting rules. Watch for high 404 rate (bot scanning).

**Q: What if something goes wrong?**
A: See [SWAGGER_DEPLOYMENT_CHECKLIST.md](SWAGGER_DEPLOYMENT_CHECKLIST.md#rollback-plan) for rollback steps. Should be <10 minutes to revert.

### 💾 Maintenance Questions

**Q: How do we update the OpenAPI spec?**
A: Edit `services/gateway/swagger.json` directly. No code deployment needed. Update should be part of every API change.

**Q: How do we rotate the header?**
A: Edit `const API_DOCS_HEADER` in `services/gateway/src/swagger.js`, redeploy, notify team to update rules.

**Q: Can we make the header time-based?**
A: Yes, but adds complexity (HMAC, key rotation, syncing). Future enhancement. See [SWAGGER_IMPLEMENTATION_SUMMARY.md](docs/SWAGGER_IMPLEMENTATION_SUMMARY.md#future-enhancements).

---

## Next Steps

### 🎯 Now (Immediately)

1. **Read**: [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) (5 min)
2. **Choose**: Your role from the table above
3. **Follow**: Role-specific setup in [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md)
4. **Test**: Local dev first (`npm start` → `/api/docs`)

### 📅 Soon (This Sprint)

1. **Review**: Security team checks [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md#security-rationale)
2. **Setup**: Team trained (ModHeader, curl, Postman)
3. **Prepare**: [SWAGGER_DEPLOYMENT_CHECKLIST.md](SWAGGER_DEPLOYMENT_CHECKLIST.md) pre-deployment section
4. **Deploy**: To staging environment

### 🚀 Later (Next Sprint)

1. **Validate**: Staging verification passes
2. **Deploy**: To production (using checklist)
3. **Monitor**: Set up alerts and dashboards
4. **Iterate**: Collect feedback, plan enhancements

---

## Support & Escalation

### Can't Find What You Need?

1. **Quick lookup**: [SWAGGER_QUICK_REFERENCE.md](SWAGGER_QUICK_REFERENCE.md) (1 page, all answers)
2. **Specific role**: [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md) (find your section)
3. **Deep dive**: [SWAGGER_API_DOCS.md](docs/SWAGGER_API_DOCS.md) (complete reference)
4. **Technical**: [services/gateway/SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md) (implementation)

### Found an Issue?

1. **Troubleshoot**: Check relevant section in your document
2. **Verify**: Follow testing steps in [SWAGGER_SETUP.md](services/gateway/SWAGGER_SETUP.md#testing)
3. **Report**: File GitHub issue with:
   - What you were trying
   - What you expected
   - What happened
   - Environment (dev/prod, browser, tools)

### Have a Question Not Listed?

1. Check FAQ in [SWAGGER_TEAM_RUNBOOK.md](docs/SWAGGER_TEAM_RUNBOOK.md#frequently-asked-questions)
2. Search this index
3. Ask your team or file an issue

---

## Document Reading Times

| Document | Read Time | When |
|----------|-----------|------|
| QUICK_REFERENCE | 5 min | First time |
| TEAM_RUNBOOK | 10 min | Role-specific setup |
| API_DOCS | 20-30 min | Deep dive |
| SETUP | 10-15 min | Maintaining code |
| IMPLEMENTATION_SUMMARY | 15 min | Preparing deployment |
| DEPLOYMENT_CHECKLIST | 20 min | Before production |

**Total Time to Deployment**: ~60 min (planning + dev + testing + deploy)

---

## Ownership & Maintenance

| Responsibility | Owner | Contact |
|---|---|---|
| Documentation | Platform Team | (team email) |
| Code Implementation | Backend Team | (team email) |
| Monitoring/Alerts | DevOps/SRE | (team email) |
| Security Review | Security Team | (team email) |
| Spec Updates | API Owners | (team email) |

**Last Updated**: 2026-08-24

---

## Version & Links

**Current Version**: 1.0.0  
**Status**: ✅ Complete and ready for deployment  
**Related Docs**: See files listed above

---

## Quick Command Reference

```bash
# Local development
npm start
curl http://localhost:4000/api/docs

# Production with curl
curl -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json

# Production with jq (pretty-print)
curl -s -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/swagger.json | jq .

# Testing gating (should fail)
curl -I https://api.aifleet.com/api/docs  # 404

# Testing gating (should succeed)
curl -I -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs  # 200

# Verify deployment
curl -f -H "x-ai-fleet-api-docs: enabled" https://api.aifleet.com/api/docs > /dev/null && echo "✅ OK"
```

---

**Everything you need is linked above. Pick a document and start reading!** 👉
