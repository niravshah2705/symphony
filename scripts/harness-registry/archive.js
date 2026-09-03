'use strict';

// Re-export shim: the deterministic tar+gzip create/extract implementation now
// lives in @ai-fleet/shared-core so the harness-registry BUILDER (here) and the
// runtime MATERIALIZER (shared-core registry/materialize.js) share one source of
// truth. Kept so existing `require('./archive')` call sites keep resolving.
module.exports = require('../../packages/shared-core/src/agent/registry/archive');
