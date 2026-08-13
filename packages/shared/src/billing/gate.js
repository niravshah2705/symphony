'use strict';

// Re-export shim: real implementation moved to SDK-free shared-core so the
// gateway can apply the same admission rule without depending on agent code.
module.exports = require('@ai-fleet/shared-core/billing/gate');
