'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

/**
 * Optional MCP tool loader for the agent framework. A workflow may declare
 * `mcp: ['linear', 'github']`; this resolves those to LangChain tools via
 * @langchain/mcp-adapters when the servers are enabled/configured.
 *
 * Everything here is best-effort and OFF by default:
 *   - unknown/disabled servers are skipped,
 *   - a missing @langchain/mcp-adapters dependency degrades to no MCP tools,
 *   - a connection error yields no tools rather than failing the run.
 * So enabling MCP never breaks the standard (built-in tools) flow.
 */

/** Whether a named MCP server is enabled and has the credentials it needs. */
function isConfigured(name, ctx) {
  const conf = CONFIG.MCP[name];
  if (!conf || !conf.enabled) return false;
  if (name === 'linear') return Boolean(ctx.apiKey); // Bearer = stored Linear key
  if (name === 'github') return Boolean(conf.token);
  return false;
}

/** MultiServerMCPClient server entry for a named server. */
function serverConfig(name, ctx) {
  const conf = CONFIG.MCP[name];
  if (name === 'linear') {
    return { url: conf.url, headers: { Authorization: `Bearer ${ctx.apiKey}` } };
  }
  if (name === 'github') {
    return { url: conf.url, headers: { Authorization: `Bearer ${conf.token}` } };
  }
  return null;
}

/**
 * Load MCP tools for the named servers. Returns [] when none are configured, the
 * adapter dependency is absent, or the connection fails.
 * @param {string[]} names  e.g. ['linear', 'github']
 * @param {{ apiKey?: string, step?: Function }} ctx
 * @returns {Promise<object[]>} LangChain tools
 */
async function loadMcpTools(names, ctx = {}) {
  const wanted = (Array.isArray(names) ? names : []).filter((n) => isConfigured(n, ctx));
  if (!wanted.length) return [];

  let MultiServerMCPClient;
  try {
    ({ MultiServerMCPClient } = require('@langchain/mcp-adapters'));
  } catch (_) {
    log.warn('MCP tools requested but @langchain/mcp-adapters is not installed; skipping.');
    return [];
  }

  const mcpServers = {};
  for (const name of wanted) mcpServers[name] = serverConfig(name, ctx);

  try {
    const client = new MultiServerMCPClient({
      useStandardContentBlocks: true,
      prefixToolNameWithServerName: true,
      onConnectionError: 'ignore',
      mcpServers,
    });
    const tools = await client.getTools();
    log.info(`MCP: loaded ${tools.length} tool(s) from ${wanted.join(', ')}.`);
    return tools;
  } catch (err) {
    log.warn(`MCP tool load failed (${wanted.join(', ')}): ${err && err.message ? err.message : err}`);
    return [];
  }
}

module.exports = { loadMcpTools, isConfigured };
