'use strict';

// Re-export shim: the SDK-free workflow-pattern catalog moved to
// @ai-fleet/shared-core so the router gateway (and other lightweight callers)
// can use it without importing the agent/harness tree. Kept so existing
// '@ai-fleet/shared/agent/workflow-patterns' imports and internal relative
// requires keep resolving.
module.exports = require('@ai-fleet/shared-core/agent/workflow-patterns');
