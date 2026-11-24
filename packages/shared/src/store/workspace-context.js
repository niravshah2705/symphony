// Re-export shim: real implementation moved to @software-factory/shared-core.
// Keeping this path ensures all services and the store share one AsyncLocalStorage
// instance after the shared-core split.
module.exports = require('@software-factory/shared-core/store/workspace-context');
