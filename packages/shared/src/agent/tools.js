'use strict';

const linear = require('../linear');
const { webSearchMany, formatResults } = require('./search');

/**
 * Tool registry for the agent framework. Workflow files reference tools by name
 * (e.g. `tools: ['web_search']`); the framework resolves each name to a LangChain
 * tool instance via `build(name, ctx)`. Keeping tool construction here (rather
 * than inline in each agent) lets planning and coding workflows share the same
 * tools and avoids re-implementing them per agent.
 *
 * `ctx` carries per-run collaborators: `{ step, apiKey }`.
 *   - step(message, level?)  progress callback (optional)
 *   - apiKey                 Linear server-side key (for linear_graphql)
 */

/** web_search: batch web search grounding tool (queries run in parallel). */
function webSearchTool(ctx = {}) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');
  const step = typeof ctx.step === 'function' ? ctx.step : () => {};
  return tool(
    async ({ queries }) => {
      const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean).slice(0, 6);
      step(`🔎 agent web search (${list.length} quer${list.length === 1 ? 'y' : 'ies'} in parallel)`);
      const batch = await webSearchMany(list, 5); // concurrent
      return batch.map((r) => `## ${r.query}\n${formatResults(r.snippets)}`).join('\n\n');
    },
    {
      name: 'web_search',
      description:
        'Search the web for current, real-world information. Pass an ARRAY of queries in `queries` ' +
        'to run several searches IN PARALLEL and get all their snippets back at once.',
      schema: z.object({
        queries: z.array(z.string()).min(1).describe('one or more search queries to run in parallel'),
      }),
    }
  );
}

/** linear_graphql: run ONE Linear GraphQL op with the server-side key (token never leaves the server). */
function linearGraphqlTool(ctx = {}) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');
  const step = typeof ctx.step === 'function' ? ctx.step : () => {};
  const apiKey = ctx.apiKey;
  return tool(
    async ({ query, variables }) => {
      const op = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      step(`🔗 linear_graphql: ${op}…`);
      try {
        const data = await linear.linearRequest(apiKey, query, variables || {});
        return JSON.stringify(data);
      } catch (err) {
        return JSON.stringify({ error: err && err.message ? err.message : String(err) });
      }
    },
    {
      name: 'linear_graphql',
      description:
        'Run ONE Linear GraphQL operation (query or mutation) against the Linear API using the ' +
        'server-side key. Pass `query` (GraphQL string) and optional `variables` (object). ' +
        'Returns the JSON `data` (or `{error}`). Use for reading the issue, managing the Workpad ' +
        'comment (commentCreate/commentUpdate), and transitioning state (issueUpdate).',
      schema: z.object({
        query: z.string().describe('A single GraphQL query or mutation'),
        variables: z.record(z.any()).optional().describe('GraphQL variables object'),
      }),
    }
  );
}

const FACTORIES = Object.freeze({
  web_search: webSearchTool,
  linear_graphql: linearGraphqlTool,
});

/** Build a single tool by registry name (returns null for unknown names). */
function build(name, ctx) {
  const factory = FACTORIES[name];
  return factory ? factory(ctx) : null;
}

/** Build all tools named in `names`, dropping unknown names. */
function buildMany(names, ctx) {
  return (Array.isArray(names) ? names : []).map((n) => build(n, ctx)).filter(Boolean);
}

module.exports = { build, buildMany, webSearchTool, linearGraphqlTool, FACTORIES };
