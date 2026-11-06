// Re-export shim: real implementation moved to @ai-fleet/shared-core.
// Kept so services that depend only on this package can validate a traceparent
// without reaching through to shared-core directly.
module.exports = require('@ai-fleet/shared-core/traceparent');
