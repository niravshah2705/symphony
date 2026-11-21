---
name: guest-webapp-demo
description: Build and deploy a small static webapp for an unauthenticated demo session, from a fixed set of options the visitor clicks. Use only when running the guest demo.
---

# guest-webapp-demo

Turn one clicked starter command into a deployed static webapp and a preview URL. The
visitor never types: every choice you may act on arrived as an id from
`packages/shared-core/src/agent/guest-demo/catalog.js`, and the template and variant are
already resolved for you.

This skill is first-party and lives outside `agent/skills/` and `registry/sources.json`. It is
never published as an OCI artifact and never appears in `registry/skill-catalog.json` — the
`AgentTemplate` that mounts it is rendered for display, not applied to a cluster.

## What you are given

- `template` — one of `helloworld`, `tic-tac-toe`, `clone-storefront`, `clone-saas-landing`,
  `clone-docs-site`. Its bundle is in `../templates/<template>/` and is already deployable:
  the presetup manifest ships with it, so nothing has to be authored to get a release out.
- `variant` — the accumulated fixed answers, e.g. `{ stack: 'node', accent: 'emerald',
  extra: 'footer' }`. Each key maps to a documented knob in that bundle's `variant.json`.
- `depth` — for a reverse-engineer run, `map` (component map plus clone plan only) or `full`
  (the rebuilt page).

## Steps

1. **Plan the build.** State the target template, the variant keys that apply, and the one
   change each key makes. Keep it to the four steps below; do not invent a fifth.
2. **Scaffold.** Copy the bundle. Apply the variant by substituting only the knobs listed in
   `variant.json` — a key that is not listed there is not a knob, and guessing one is how a
   demo ends up shipping something the visitor never asked for.
3. **Code and test.** The bundle is static: verify each page loads, the interactive behaviour
   works (tic-tac-toe win detection, the clone's nav), and no asset 404s. There is no build
   step to run and no dependency to install.
4. **Deploy as a webapp.** Release the bundle through the guest deployer and return the
   preview URL. The URL is the one for this session and does not change when a customisation
   re-releases it.

## Rules

- Offer only the options you were given. If the visitor appears to want something else, say
  that a signed-in workspace is where free text lives — then present the next fixed question.
- Never read, write, or reference tenant state: no organization, project, ticket, repository,
  conversation, or secret. There is no organization in scope for a guest session, which is not
  a permission to look one up.
- Never emit a credential, a token, a connection string, or a key-shaped string into the site,
  its config, or your own report. The preview is public by design.
- Nothing here is applied to a cluster. Rendered manifests are shown as a simulated preview and
  labelled as such.
- The session and its preview live for 1 day. Say so when you hand over the URL; do not imply
  the visitor can come back later and find the conversation.
