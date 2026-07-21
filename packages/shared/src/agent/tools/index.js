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

const DOMAINS = Object.freeze({
  docker: docker.FACTORIES,
  environments: environments.FACTORIES,
  build: build.FACTORIES,
  android: android.FACTORIES,
  security: security.FACTORIES,
  quality: quality.FACTORIES,
  codegen: codegen.FACTORIES,
  playwright: playwright.FACTORIES,
});

const TOOL_FACTORIES = Object.freeze(
  Object.assign({}, ...Object.values(DOMAINS))
);

/** All developer-tool names this folder contributes (stable, sorted). */
const TOOL_NAMES = Object.freeze(Object.keys(TOOL_FACTORIES).sort());

module.exports = { TOOL_FACTORIES, TOOL_NAMES, DOMAINS };
