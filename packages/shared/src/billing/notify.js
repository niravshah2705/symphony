'use strict';

// Re-export shim: the real implementation lives in @ai-fleet/shared-core so the
// billing service and the agent runtime run ONE money path, not two that drift.
module.exports = require('@ai-fleet/shared-core/billing/notify');
