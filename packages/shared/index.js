'use strict';

/**
 * Convenience barrel for @ai-fleet/shared. Services normally import the specific
 * subpath they need (e.g. `require('@ai-fleet/shared/agent/scheduler')`), which
 * keeps their dependency surface explicit; this barrel is a shortcut for the
 * most common pieces and for interactive use.
 */

module.exports = {
  CONFIG: require('./src/config').CONFIG,
  store: require('./src/store'),
  linear: require('./src/linear'),
  log: require('./src/logger'),
  util: require('./src/util'),
};
