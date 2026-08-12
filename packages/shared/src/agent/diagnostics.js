'use strict';

// Re-export shim: the SDK-free diagnostics probes moved to @ai-fleet/shared-core
// so the router gateway can serve /observability without importing the
// agent/harness tree. Kept so existing '@ai-fleet/shared/agent/diagnostics'
// imports and internal relative requires keep resolving.
module.exports = require('@ai-fleet/shared-core/agent/diagnostics');
