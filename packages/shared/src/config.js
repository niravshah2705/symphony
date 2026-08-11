// Re-export shim: real implementation moved to @ai-fleet/shared-core.
// Kept so existing '@ai-fleet/shared/config' imports and internal relative
// requires keep resolving after the shared-core split.
module.exports = require('@ai-fleet/shared-core/config');
