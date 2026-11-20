// Re-export shim: real implementation moved to @software-factory/shared-core.
// Kept so existing '@software-factory/shared/config' imports and internal relative
// requires keep resolving after the shared-core split.
try {
  module.exports = require('@software-factory/shared-core/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    module.exports = require('../../shared-core/src/config');
  } else {
    throw err;
  }
}
