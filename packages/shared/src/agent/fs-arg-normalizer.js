'use strict';

/**
 * Repair deep-agent filesystem tool calls whose path argument the model placed
 * under the wrong key.
 *
 * The deepagents read_file/write_file/edit_file tools require a `file_path`
 * argument, while their sibling glob/grep tools use `path`. Smaller local
 * models routinely conflate the two and call read_file with `path`. The tool's
 * Zod schema then rejects the call:
 *
 *   Invalid input: expected string, received undefined → at file_path
 *
 * In the deep-agent runtime that validation error aborts the whole run instead
 * of being handed back to the model to retry, so a single mis-keyed argument
 * fails the entire task.
 *
 * This middleware normalizes the call before it reaches the tool: for the
 * file_path-taking tools, if `file_path` is absent but a well-known alias
 * (path/filepath/…) carries the value, it is copied into `file_path`. Correct
 * calls are returned untouched, and glob/grep (which legitimately use `path`)
 * are never rewritten.
 */

const { createMiddleware } = require('langchain');

/** Deepagents tools whose schema requires a `file_path` string argument. */
const FILE_PATH_TOOLS = Object.freeze(new Set(['read_file', 'write_file', 'edit_file']));

/** Keys a model might use instead of `file_path`, checked in priority order. */
const FILE_PATH_ALIASES = Object.freeze(['path', 'filepath', 'filePath', 'file', 'filename']);

/**
 * Return args with `file_path` filled in from a known alias when it is missing.
 * Never mutates the input; returns the same reference when no change is needed.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function normalizeFsToolArgs(toolName, args) {
  if (!FILE_PATH_TOOLS.has(toolName) || !args || typeof args !== 'object') return args;
  // A usable file_path is already present — leave the call exactly as-is.
  if (typeof args.file_path === 'string' && args.file_path) return args;
  const aliasKey = FILE_PATH_ALIASES.find((key) => typeof args[key] === 'string' && args[key]);
  if (!aliasKey) return args;
  const { [aliasKey]: aliasValue, ...rest } = args;
  return { ...rest, file_path: aliasValue };
}

/**
 * Build a LangChain agent middleware that repairs mis-keyed filesystem tool
 * calls. Append to the deep-agent middleware stack via createDeepAgent.
 *
 * @returns {import('langchain').AgentMiddleware}
 */
function createFsArgNormalizerMiddleware() {
  return createMiddleware({
    name: 'FsArgNormalizer',
    wrapToolCall: (request, handler) => {
      const toolCall = request && request.toolCall;
      if (!toolCall) return handler(request);
      const fixed = normalizeFsToolArgs(toolCall.name, toolCall.args);
      if (fixed === toolCall.args) return handler(request);
      return handler({ ...request, toolCall: { ...toolCall, args: fixed } });
    },
  });
}

module.exports = {
  createFsArgNormalizerMiddleware,
  normalizeFsToolArgs,
  FILE_PATH_TOOLS,
  FILE_PATH_ALIASES,
};
