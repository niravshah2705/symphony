// Re-export shim: real implementation moved to @ai-fleet/shared-core.
// Keeping this path ensures all services and the store share one AsyncLocalStorage
// instance after the shared-core split.
module.exports = require('@ai-fleet/shared-core/store/workspace-context');
