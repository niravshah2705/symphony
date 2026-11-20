'use strict';

// Re-export shim: the SDK-free diagnostics probes moved to @software-factory/shared-core
// so the router gateway can serve /observability without importing the
// agent/harness tree. Kept so existing '@software-factory/shared/agent/diagnostics'
// imports and internal relative requires keep resolving.
module.exports = require('@software-factory/shared-core/agent/diagnostics');
