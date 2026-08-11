# Security Policy

AI Fleet is a local-first tool that brokers third-party credentials (Linear,
GitHub/GitLab, and LLM providers) and runs autonomous agents against your projects.
We take its security posture seriously and appreciate responsible disclosure.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |
| < 1.0   | ❌        |

Only the latest `1.0.x` release line receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for a
security vulnerability, and do not disclose it publicly until it has been fixed.**

Report privately through either channel:

1. **GitHub private security advisory** (preferred) — on this repository, open the
   **Security** tab → **Report a vulnerability**. This creates a private advisory that
   only the maintainers can see.
2. **Email** — `nirav.s@uipath.com`. Encrypt if you can; otherwise send a plain-text
   report and we will follow up.

Please include:

- a description of the issue and the impact you believe it has;
- the affected component/service (`gateway` / `planner` / `coder` / `proxy` /
  `settings` / `org` / `shared`) and the version or commit;
- clear reproduction steps or a proof of concept;
- any relevant logs or output — **with secrets redacted**.

## What to expect

- We aim to acknowledge a report within a few business days.
- We will confirm the issue, assess severity, and keep you updated on the fix.
- With your consent, we are happy to credit you once a fix ships.

This is a small project maintained on a best-effort basis; the timelines above are
targets, not contractual guarantees.

## Handling secrets in a report

If your report involves a leaked or guessable credential, **treat any exposed secret
as compromised and rotate it immediately** — the Linear key, GitHub/GitLab token, LLM
provider key, and any Codex/Claude OAuth tokens. Never paste a live secret into an
issue, advisory, or email; redact it first.

## Security model (how AI Fleet protects credentials)

The README's [**Security notes**](./README.md#security-notes) are the authoritative,
detailed description of the design. In summary:

- **Secrets stay server-side.** Provider keys and OAuth tokens live only in the
  server-side store, are masked in API responses, and are never sent to the browser.
  The local store directory (`data/`) is git-ignored.
- **Repository credentials are brokered.** Stored GitHub/GitLab tokens never enter the
  code agent's shell environment, prompt, tool arguments, origin URL, or `.git/config`;
  authenticated Git and PR/MR operations run through a broker scoped to a fixed
  host/repository/branch/refspec.
- **Egress proxy sidecar.** In the deployed topology, agent containers hold no raw
  third-party credential — an egress proxy injects the real secret on outbound calls.
- **OAuth uses PKCE (S256)** with a single-use, server-issued `state` (CSRF/replay
  guard); provider URLs and client IDs are trusted server-side config and are never
  taken from the browser.
- **Prompt-injection defenses.** Tracker- and web-sourced text is fenced as data, and
  LLM output is schema-validated and clamped before any write.
- **Local shell trust boundary.** `LocalShellBackend` is a host shell rooted by
  convention, **not** an OS sandbox. Run the coder only for trusted repositories and
  tickets; stronger isolation requires a separate container/VM. See the README for the
  full caveat.

## Hardening recommendations for operators

- In the cloud (`AUTH_MODE=firebase`), restrict sign-in with `FIREBASE_ALLOWED_DOMAIN`
  or `FIREBASE_ALLOWED_EMAILS`, and keep the app scoped to trusted operators.
- Keep `data/` out of version control (it is git-ignored by default) and back it up
  securely — it contains your keys and tokens.
- Enable **GitHub secret scanning + push protection** on this repository so a
  credential can never be committed, regardless of repo visibility.
- Only run repositories and tickets you trust through the coder agent.
