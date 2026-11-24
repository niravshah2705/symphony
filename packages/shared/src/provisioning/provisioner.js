// Re-export shim: real implementation moved to @software-factory/shared-core.
// Kept so existing '@software-factory/shared/provisioning/provisioner' imports and internal relative
// requires keep resolving after the shared-core split.
module.exports = require('@software-factory/shared-core/provisioning/provisioner');
