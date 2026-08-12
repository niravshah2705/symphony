'use strict';

// Re-export shim: the provider-neutral agent-runtime layer moved to the
// pluggable, in-package harness registry under ./harnesses. Kept so existing
// `@ai-fleet/shared/agent/runtimes` imports and internal relative requires keep
// resolving after the split. Requiring ./harnesses registers every built-in
// harness (deepagent, codex-sdk, claude-agent-sdk, antigravity-sdk) and exposes
// the same public surface this module used to export.
module.exports = require('./harnesses');
