'use strict';

// Re-export shim: the SDK-free workflow-pattern catalog moved to
// @software-factory/shared-core so the router gateway (and other lightweight callers)
// can use it without importing the agent/harness tree. Kept so existing
// '@software-factory/shared/agent/workflow-patterns' imports and internal relative
// requires keep resolving.
module.exports = require('@software-factory/shared-core/agent/workflow-patterns');
