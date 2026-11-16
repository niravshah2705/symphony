# AGPL / enterprise-license memo: self-hosted FlexPrice

**Item 18 of the Phase 0 plan. This is the hard gate: the plan says no Phase 1
code may be written before this memo is signed.**

Written by an engineering agent from the license texts in the repository itself.
It is **not legal advice** and must not be relied on as a legal opinion — the
conclusion is a set of facts plus an engineering risk assessment, and the decision
it asks for is commercial. Route it to counsel with the three questions in §7.

Repo examined: `/tmp/fp-research/flexprice`, HEAD `709ff3bc`,
`git describe` = `v2.1.48-226-g709ff3bc6`. Every line reference below was checked
first-hand, not quoted from a summary.

---

## 1. Bottom line

The plan's locked decision was **"AGPL-3.0 core, `internal/ee` untouched."**

That decision cannot be executed as written, for one reason: **the wallet, the
event ingest path and the invoice/credit engine — the three things we are adopting
FlexPrice for — are inside `internal/ee`.** There is no AGPL-only path to a
FlexPrice wallet, and no way to build one without that package, because the code
is compiled into every binary unconditionally.

The consequence is a fork in the road, not a nuance:

| What we wanted | What is true |
|---|---|
| Run the open-source core | The published image contains `internal/ee`, ~531 of 2638 Go files (~20%; 253 of 2011 once tests are excluded), which `internal/ee/LICENSE` says may be **used in production only with a paid Flexprice Enterprise license** |
| Stay clear of the commercial part | `cmd/server/main.go:21-31,65` imports `internal/ee/service` and eight more ee packages directly; there is **no build tag, no license key, no runtime edition check** that can exclude or disable it |
| Not fork Go (decided) | Good — this is currently our strongest mitigating fact, see §4 |
| Read the README's "99% open source" | `README.md:195` claims the commercial portion is "the last 1%". At this commit it is ~20% of the Go files and it includes billing itself |
| Assume the boundary was drawn deliberately | It was drawn by **moving files**, in one commit whose message does not mention licensing — see §2a. That is the strongest single fact we can put in front of the vendor |

**Recommendation:** proceed with the local Phase 0 spike (it is expressly permitted,
§4.1), and **do not deploy FlexPrice to production, and do not start Phase 1
integration code, until §7 is answered in writing** — either by FlexPrice or by
counsel, or by choosing a different platform.

---

## 2. The facts, verified on disk

| # | Fact | Evidence |
|---|---|---|
| F1 | Root `LICENSE` is the verbatim GNU AGPL-3.0 full text, preceded by `Copyright (c) 2024-present SQUIRRELLY TECHNOLOGIES PRIVATE LIMITED` (`LICENSE:1`). No exception, additional permission, or carve-out is appended. | read in full |
| F2 | **There are no per-file license headers anywhere in the Go tree.** `grep -rn "SPDX" --include="*.go" .` → **0 hits.** `internal/ee/service/wallet.go` and `internal/ee/service/subscription.go` begin with `package service` + imports, nothing else. | checked |
| F3 | A separate license exists at `internal/ee/LICENSE` (2217 bytes, 35 lines): "The Flexprice Enterprise license (the "Enterprise License")", `Copyright (c) 2024-2026 SQUIRRELLY TECHNOLOGIES PRIVATE LIMITED`. | read in full |
| F4 | Its operative grant: production use requires agreement to the Flexprice Subscription ToS **and "a valid Flexprice Enterprise license for the correct number of user seats"**; copying and modifying **for development and testing purposes is free** ("without requiring a subscription"); modifications and patches "may only be used … with a valid Flexprice Enterprise license"; Flexprice "retain all right, title and interest in and to all such modifications"; "it is forbidden to copy, merge, publish, distribute, sublicense, and/or sell the Software". | `internal/ee/LICENSE:1-23` |
| F5 | The machine-readable declaration the authors themselves use is unqualified: `cmd/server/main.go:77-78` → `@license.name AGPL-3.0`, `@license.url https://www.gnu.org/licenses/agpl-3.0.html`. The published image label is `org.opencontainers.image.licenses=AGPL-3.0-only` (`.github/workflows/publish-app-image.yml`). | checked via research pass |
| F6 | **No edition gate of any kind.** Every `go:build` constraint in the tree is a test or tooling tag — `published`, `e2eprobe_integration`, `integration`, `pgintegration`, `pgbench`, `ignore`. Inside `internal/ee/` there are exactly **2** such files (`ee/e2eprobe/billingmatrix/live_test.go`, `ee/service/revenuereport/bench_pg_test.go`), both tests. `FLEXPRICE_LICENSE`, `licenseKey`, `IsEnterprise`, `enterprise license` → 0 hits in Go source. No "feature not available in your plan" error exists. | `grep -rhn 'go:build' --include='*.go'` over the tree, and over `internal/ee/` alone |
| F7 | `ARG BUILD_VARIANT=Enterprise` (`Dockerfile:25`) is ldflag-injected into `internal/buildinfo.BuildVariant` (also defaulting to `"Enterprise"` at `internal/buildinfo/buildinfo.go:7`) and its **only** consumers are telemetry payload fields (`internal/telemetry/events.go:47,83`). No non-`Enterprise` value appears anywhere in the repo. It is a label, not a switch. | checked |
| F8 | `Dockerfile:17` is `COPY . .` and `:31` is a single `go build ./cmd/server`. `internal/ee` is unconditionally compiled and, per F9, unconditionally wired. | checked |
| F9 | `cmd/server/main.go:21-31` and `:65` import nine ee packages — `ee/analytics`, `ee/auth/saml`, **`ee/service`**, `ee/service/accountingperiod`, `ee/service/admin`, `ee/service/contract`, `ee/service/journal`, `ee/service/pob`, `ee/service/revenue`, `ee/service/revenuereport`, `ee/service/selfbilling`, `ee/service/sync/export`. The ee service package is also imported from **outside** `internal/ee` by code that is not optional in any deployment: `internal/webhook/module.go:7`, `internal/webhook/payload/services.go:4`, `internal/temporal/registration.go:6`, `internal/temporal/activities/{plan,billingentity,marketplace,chargebee}/…`. Excluding it is therefore not a matter of deleting one import line. | checked |
| F10 | The features Phase 1 depends on are in that package: `internal/ee/service/wallet.go` (top-up, debit, balance), `event.go` (ingest), `invoice.go` (finalize + `ApplyCreditsToInvoice`), `credit_expiry.go`, `payment_processor.go`, `creditgrant.go`, `meter.go`, `price.go`, `coupon.go`, `subscription.go`. | checked (`ls internal/ee/service/`) |
| F11 | The one "edition-like" mechanism found is a link-time registration pattern for SAML only: if the ee SAML package is not linked, config writes fail with "saml is not available in this build" (`internal/types/settings.go:1301`, `internal/auth/saml_provider.go:16`). Since F8/F9 always link it, this never fires in the published image. It also shows the *intended* pattern — and that it was applied to one optional feature, not to billing. | checked |
| F12 | Size at this commit: 531 Go files under `internal/ee`, 2638 in the tree. | counted |
| F13 | `DEPLOYMENT_MODE` (`local/api/consumer/temporal_worker/admin`) selects process roles, not editions. Feature availability is governed by ordinary config flags (e.g. `CommitmentsV2Config.Enabled`, `internal/types/settings.go:1315-1330`) — configuration, not licensing. | checked |
| F14 | Upstream's **own** architecture doc states the scope rule the Enterprise license is asserted under: `docs/ARCHITECTURE.md:24` — "6. **Enterprise boundary** — `internal/ee/**` encapsulates commercially licensed deltas; compose via Fx similarly to core services." So F2's absence of per-file headers does not leave the encumbered set undefined; the repo defines it by **directory**. | read at `docs/ARCHITECTURE.md:24` |
| F15 | `README.md:195` names two encumbered locations, "`ee` , `internal/ee`". At this commit **there is no top-level `ee/` directory** — only `internal/ee/`. The vendor's licensing sentence is stale relative to the tree it describes, which matters because it is the sentence counsel will be handed. | `ls -d ee` → absent |
| F16 | 🔴 **The encumbered set is a directory move, not an authoring decision.** The service layer used to live at `internal/service/`. Commit `921e34c6a` (2026-06-17, `omkar273`, *"feat(service): implement Addon and AlertLogs services"*) renamed it: `git show --stat` → **150 files changed, 0 insertions(+), 0 deletions(-)**, every one an `internal/{=> ee}/service/*.go` rename, none touched by any other change in the commit. No `go:build` tag, no licence header, no code edit accompanied it. `internal/service/` now contains exactly two files, `AGENTS.md` and `CLAUDE.md`. | `git log --diff-filter=D -- internal/service/*.go`, `git show --numstat 921e34c6a` |

## 2a. What F16 changes about the question

F16 is the most useful fact in this memo, because it reframes what we are asking.

The plan's locked decision — "AGPL core, `internal/ee` untouched" — treats the
encumbered set as a *product* boundary: some capabilities are commercial. F16 shows
it is a *path* boundary that moved **150 files, zero of them edited, in a commit
whose message is about two unrelated new services.** The identical bytes were AGPL
on 2026-06-16 and Enterprise on 2026-06-17. Nothing about the code's function
changed; only its directory did.

Three consequences:

1. **For the vendor ask (§6 option 2), it is a specific, checkable question** rather
   than a general one: *was `internal/service → internal/ee/service` intended to
   move wallet/invoice/meter/price out of the AGPL grant, and if so where is that
   recorded besides a `git mv`?* Upstream's README:197 already invites exactly this
   question ("we have moved things from commercial to open in the past … open a
   discussion if you feel like something is wrong"), which makes it a conversation
   we are entitled to have rather than a negotiation.
2. **For counsel, it weakens a "notice controls" reading and strengthens F1/F5.**
   If placement alone re-licenses, then the AGPL-only root licence, the
   `@license.name AGPL-3.0` swag declaration and the image's
   `AGPL-3.0-only` label (F5) are all statements about bytes the holder had just
   moved — and every one of them says AGPL. A party who wants a subdirectory under
   commercial terms has a reasonable expectation to say so in the file or the commit,
   not only in a README parenthetical.
3. **For option 4/5, it does not help.** A licence-clean older commit is not
   available to us in practice: the boundary predates our adoption *and* moves with
   each release, so "pin the last commit where billing was AGPL" means pinning an
   arbitrarily old FlexPrice and forfeiting the fixes we adopted it for. Judge the
   options on §6 as written, not on this idea.

The honest summary remains §1: **we cannot tell from this repo whether running the
published image for our customers is permitted.** F16 makes the ambiguity better
documented and the vendor question sharper; it does not resolve it.

## 3. The two license texts, in their own words

**AGPL-3.0 `LICENSE:89-91` — what "convey" is not:**

> To "convey" a work means any kind of propagation that enables other parties to
> make or receive copies. Mere interaction with a user through a computer network,
> with no transfer of a copy, is not conveying.

**AGPL-3.0 `LICENSE:542-553` — §13, "Remote Network Interaction; Use with the GNU
General Public License":**

> Notwithstanding any other provision of this License, **if you modify the
> Program**, your modified version must prominently offer all users interacting
> with it remotely through a computer network (if your version supports such
> interaction) an opportunity to receive the Corresponding Source of your version
> by providing access to the Corresponding Source from a network server at no
> charge, through some standard or customary means of facilitating copying of
> software. …

Two textual features matter here. The duty is conditioned on **modifying** the
Program; and the obligor is whoever runs/transmits the modified version — a
downstream user of our instance would be a beneficiary, not the obligated party.

**AGPL-3.0 §5 (`LICENSE:198-224`) — conveying a modified version** requires
prominent notices stating it was modified and when (§5a), that it is released under
this License (§5b), licensing the whole work to anyone who receives a copy (§5c),
and Appropriate Legal Notices in any interactive UI (§5d).

**`internal/ee/LICENSE`** grants *less* than the AGPL does for the same bytes:
the AGPL grants unlimited use, modification and redistribution subject to
copyleft conditions; the Enterprise license withholds production use entirely
absent a paid subscription, and claims ownership of our modifications.

**The conflict is real and it is the whole question.** The root AGPL text covers
the tree with no carve-out and no per-file headers to contradict it (F1, F2),
while the copyright holder — who is the same legal entity in both files, and the
only party who can grant rights over either — asserts commercial terms over a
subdirectory (F3, F4). A copyright holder may dual-license and may choose which
terms attach to which files, so "the root LICENSE says AGPL" is not obviously
dispositive for `internal/ee/`. Equally, a file that carries no notice, inside a
tree published under an unqualified AGPL declaration and an image labelled
`AGPL-3.0-only` (F5), is not obviously encumbered. **This is a contract/ownership
question about a genuine ambiguity in someone else's licensing, and no amount of
reading the repo resolves it.**

## 4. Scenario analysis

### 4.1 Phase 0 as currently scoped — local, unmodified, internal → low exposure

Running an **unmodified** upstream image on a laptop with our own Node code
talking to it over REST:
- `internal/ee/LICENSE` expressly permits use for development and testing without a
  subscription (F4). This is the current situation.
- AGPL §13 attaches "if you modify the Program". We do not.
- Nothing is conveyed to anyone.
- No external user interacts with it.

**Continue Phase 0** (compose stack, spike, findings). It is the work that produces
the evidence for §7, and stopping it gains nothing.

### 4.2 Phase 1 deployed to production, still unmodified → **this is the gate**

- `internal/ee/LICENSE` conditions **production use** on a paid Enterprise license,
  and per F10 the wallet and event ingest are that package. The features we would
  bill customers on are precisely the encumbered ones. There is no configuration
  that routes around this: it is not a feature flag (F6, F11, F13).
- AGPL §13 still does not bite if we ship no modification.
- Net: the AGPL is not our problem here; **the Enterprise license is**, and it is
  unavoidable if the ambiguity resolves against us.

### 4.3 Any modification — a Go patch, a vendored fix, a template change

The worst combination, and worth understanding even though "no Go fork" is a locked
decision:
- AGPL §13's source-offer duty engages (we serve customers over a network),
  including Appropriate Legal Notices in any FlexPrice-served UI we ship (§5d).
- `internal/ee/LICENSE` then says that modification is ours only in dev/test and
  may not be used in production without a license, **and that Flexprice owns it**
  (F4) — so a bug fix we contributed to the billing path could be encumbered before
  we write it.
- The "no Go fork" decision is therefore doing double duty: it is an architecture
  choice *and* the main reason §4.1 stays low-risk. It should not be revisited
  casually. Note this also rules out the tempting small patch — e.g. changing a
  GST rounding or a currency validation in Go. If we need that, we need a license.

### 4.4 What is *not* affected

- **Our own code.** `packages/shared-core/src/billing/*.js`, the gateway, the
  runner, our UI are ours. Linking to FlexPrice over HTTP does not make our
  monorepo AGPL-derivative work in any straightforward way — the FSF's own
  position on network-separated programs is that mere aggregation/interoperation
  over a network boundary does not relicense the other side. Our repo's license
  posture does not change as a result of this integration.
- **The Phase 0 deliverables already written** — `docs/SUBSTRATE_METRICS.md`,
  `scripts/kind-metrics-install.sh`, `deploy/flexprice/kind/`, the four billing
  modules. None of them contains FlexPrice code; the `kind/` manifests are our
  snapshot of *our own* cluster's Prometheus/OTel config.
- **Cashfree staying in Node** (§0.4 of `FLEXPRICE_FINDINGS.md`) keeps us out of
  the payment-connector code, which is also ee-adjacent. Good for licensing as
  well as for scope.

## 5. What we control, and what to keep true

| Discipline | Why it limits exposure |
|---|---|
| Run the published image **unmodified**, pinned by digest (`ghcr.io/flexprice/flexprice@sha256:…`) | Keeps us out of §13 and out of the "we own your patch" clause |
| Never edit anything under `internal/ee/`, not even a comment | F4 attaches to "modifications and/or patches" broadly |
| All customisation outside Go: config, REST, our own UI | The AGPL obligations scale with modification; ours should stay zero |
| We render every customer-facing billing screen; never embed or expose the FlexPrice dashboard/checkout to customers | Avoids shipping a FlexPrice-served interactive UI, which is where §5d legal notices and the "if your version supports such interaction" limb would engage. The API is fully headless — every UI function has a REST equivalent — so this is achievable |
| Nothing of FlexPrice's is copied into this repo | No conveyance from us, no derived-work argument |

The plan already satisfies all six. They should stay satisfied deliberately, and
this table is the thing to re-read before any future "just patch it in Go" idea.

## 6. Options, with engineering cost

1. **Buy the Enterprise license.** Only option that fully clears §4.2/§4.3.
   Cost: commercial; also means "correct number of user seats" applies to *us*, so
   seat definitions need checking against our team size.
2. **Get written clarification from Flexprice** that self-hosting the published
   OSS image for a commercial SaaS is permitted under AGPL alone, and that
   `internal/ee`'s notice does not restrict that. Cheap, fast, and the answer is
   probably "buy enterprise" — but it is the only way to know without counsel.
   Ask it **with F16 attached**: the 150-file zero-diff move of the service layer
   (§2a) is the version of this question that cannot be answered with boilerplate.
3. **Ask counsel to opine on whether F1/F2/F5 control over F3/F4.** The specific
   question is narrow (§7 Q1).
4. **Do not use FlexPrice for wallet/credits/events.** Fall back to the
   first-party engine already in this repo (`packages/shared-core/src/billing/`),
   which the plan proposed *deleting*. The finding that flips this is
   `FLEXPRICE_FINDINGS.md` §0.1: what FlexPrice offers that we lack is compute
   metering and a price catalog, both of which the plan already decided to compute
   ourselves (`substrate-session.js`, `compute-pricing.js`). **This option is less
   expensive than the plan assumed, because Phase 0 already built the parts that
   were never FlexPrice's to give us.**
5. **Evaluate a licence-clean alternative** (Lago — AGPL too, so re-check its
   `ee/` the same way; or Metronome-type commercial; or first-party). Only worth it
   if 1-3 all fail.

**Engineering recommendation: 2 and 3 in parallel, immediately, and treat 4 as the
live fallback rather than the failure case.** Do not start Phase 1 integration code
(meaning: B1-B10, the deletions in "What Phase 1 deletes") while §4.2 is unresolved.
The single most important consequence of this memo is that **the plan's Phase 1
deletion list should not be executed until the gate clears** — deleting
`ledger.js`'s money semantics and `sweep.js`'s debit path while the replacement may
not be deployable would leave the product unable to bill at all.

## 7. Questions to put to counsel / the vendor

1. Does the unqualified root `LICENSE` (AGPL-3.0, single copyright holder, no
   per-file headers anywhere in the tree, image labelled `AGPL-3.0-only`) grant us
   the right to run `internal/ee` in production, notwithstanding
   `internal/ee/LICENSE`? If the subdirectory notice controls, does it control for
   **all** of `internal/ee` — including files that carry no notice — or only some?
   Add the F16 follow-up: does a `git mv` of previously-AGPL files into `internal/ee`
   retroactively encumber those bytes, and where else besides README:195 and
   `docs/ARCHITECTURE.md:24` does the vendor document the encumbered set?
2. If we run the **unmodified** published image and serve our customers only
   through our own UI over its REST API, is there any act in that deployment which
   constitutes conveyance or modification under AGPL §0/§5/§13 as quoted in §3?
3. Does `internal/ee/LICENSE`'s "correct number of user seats" refer to *our*
   staff, or to the end customers of the product we operate? The text is written as
   if the licensee's own seats matter, which would make the clause about our team,
   not our user base — that distinction changes the price of option 1 by orders of
   magnitude.

## 8. Gate status

```
ITEM 18 (AGPL memo)          : DELIVERED — this document
                               Verdict: NOT CLEARED for production.
                               CLEARED for local Phase 0 dev/test.
Phase 0 stack + spike        : may continue (dev/test use, unmodified image)
Phase 1 (Plan B, all of it)  : BLOCKED on §7 answers, per the plan's own exit criterion
Phase 1 deletions            : EXPLICITLY BLOCKED — see §6 recommendation
Re-plan triggers fired       : 3 of 3
                               item 13 minimum stack: all containers load-bearing,
                                 but 1.39 GiB measured — fires on the letter, not the reason
                               item 18 license boundary: FIRED (§0/§4.2) — the hard one
                               item 10 key scoping: config-map key cannot be confined at
                                 all (super_admin + caller-chosen environment) and reads
                                 are shadow-only; DB-minted keys CAN be — B1 must use those
                               item 24 pre-existing actor cost: answered, read-only oracle
Signature of this memo       : ______________________  date: ____________
                               (engineering acceptance is not the gate; §7 needs counsel
                                or the vendor in writing)
```
