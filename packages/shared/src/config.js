// Re-export shim: real implementation moved to @ai-fleet/shared-core.
// Kept so existing '@ai-fleet/shared/config' imports and internal relative
// requires keep resolving after the shared-core split.
try {
  module.exports = require('@ai-fleet/shared-core/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    module.exports = require('../../shared-core/src/config');
  } else {
    throw err;
  }
}
