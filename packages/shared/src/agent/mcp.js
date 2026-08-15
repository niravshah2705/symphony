'use strict';

const { CONFIG } = require('../config');
const { SENTINEL_TOKEN, projectEgressHeaders } = require('../egress');
const { currentWorkspaceContext } = require('../store/workspace-context');
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

/** Repository-aware MCP gate. Broker-backed runs never expose a broad forge MCP. */
function repositoryAllowsMcp(name, ctx = {}) {
  if (name !== 'github') return true;
  if (ctx.repositoryProvider === 'gitlab') return false;
  if (ctx.repositoryBroker) return false;
  return true;
}

/** Interactive browser MCP is direct egress and is local/direct-mode only. */
function runtimeAllowsMcp(name, ctx = {}, runtimeEnv = process.env, config = CONFIG) {
  if (name !== 'playwright') return true;
  if (ctx.isolateNetwork === true) return false;
  if (String((config && config.EGRESS_PROXY_URL) || '').trim()) return false;
  return String((runtimeEnv && runtimeEnv.NODE_ENV) || '').trim().toLowerCase() !== 'production';
}

/** Whether a named MCP server is enabled and has the credentials it needs. */
function isConfigured(name, ctx) {
  if (!repositoryAllowsMcp(name, ctx)) return false;
  if (!runtimeAllowsMcp(name, ctx)) return false;
  const conf = CONFIG.MCP[name];
  if (!conf || !conf.enabled) return false;
  if (name === 'linear') return Boolean(CONFIG.EGRESS_PROXY_URL || ctx.apiKey);
  if (name === 'github') return Boolean(CONFIG.EGRESS_PROXY_URL || conf.token);
  if (name === 'playwright') return Boolean(conf.command); // local stdio server, no credentials
  return false;
}

/** MultiServerMCPClient server entry for a named server. */
function serverConfig(name, ctx) {
  const conf = CONFIG.MCP[name];
  if (name === 'linear') {
    const token = CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : ctx.apiKey;
    return {
      url: conf.url,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {}),
      },
    };
  }
  if (name === 'github') {
    const token = CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : conf.token;
    return {
      url: conf.url,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {}),
      },
    };
  }
  if (name === 'playwright') {
    // Local stdio server launched as a child process (no network credentials).
    return { transport: 'stdio', command: conf.command, args: Array.isArray(conf.args) ? conf.args : [] };
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

module.exports = { loadMcpTools, isConfigured, repositoryAllowsMcp, runtimeAllowsMcp };
