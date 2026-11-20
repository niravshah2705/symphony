'use strict';

// Re-export shim: the real implementation lives in @software-factory/shared-core so the
// billing service and the agent runtime run ONE money path, not two that drift.
module.exports = require('@software-factory/shared-core/billing/sweep');
