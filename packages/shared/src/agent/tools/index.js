'use strict';

/**
 * Aggregate registry for the developer-tool folder. Each domain module exports a
 * frozen `FACTORIES` map of `{ tool_name: (ctx) => LangChainTool }`. This index
 * merges them into a single `TOOL_FACTORIES` map that `../tools.js` spreads into
 * the framework's tool registry, so a workflow can reference any tool by name in
 * its `tools: [...]` array.
 *
 * To add "many more" tools: create `tools/<domain>.js` exporting a `FACTORIES`
 * map, then add it to `DOMAINS` below. Nothing else changes.
 */

const docker = require('./docker');
const environments = require('./environments');
const build = require('./build');
const android = require('./android');
const security = require('./security');
const quality = require('./quality');
const codegen = require('./codegen');
const playwright = require('./playwright');
const billing = require('./billing');

const DOMAINS = Object.freeze({
  docker: docker.FACTORIES,
  environments: environments.FACTORIES,
  build: build.FACTORIES,
  android: android.FACTORIES,
  security: security.FACTORIES,
  quality: quality.FACTORIES,
  codegen: codegen.FACTORIES,
  playwright: playwright.FACTORIES,
  billing: billing.FACTORIES,
});

const TOOL_FACTORIES = Object.freeze(
  Object.assign({}, ...Object.values(DOMAINS))
);

/** All developer-tool names this folder contributes (stable, sorted). */
const TOOL_NAMES = Object.freeze(Object.keys(TOOL_FACTORIES).sort());

/**
 * Reverse map tool name → settings ``tools`` domain (docker/build/…). Used by
 * the settings-service enforcement to drop a workflow's tools when their domain
 * is excluded. Tools with no entry here (e.g. web_search, linear_graphql) are
 * ungoverned by the tools policy and always kept.
 */
const TOOL_DOMAIN = Object.freeze(
  Object.entries(DOMAINS).reduce((acc, [domain, factories]) => {
    for (const name of Object.keys(factories)) acc[name] = domain;
    return acc;
  }, {})
);

module.exports = { TOOL_FACTORIES, TOOL_NAMES, DOMAINS, TOOL_DOMAIN };
