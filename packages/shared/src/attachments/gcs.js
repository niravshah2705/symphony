// Re-export shim: real implementation moved to @ai-fleet/shared-core.
// Kept so '@ai-fleet/shared/attachments/gcs' imports keep resolving.
module.exports = require('@ai-fleet/shared-core/attachments/gcs');
