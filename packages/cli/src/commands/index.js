'use strict';

/**
 * Command registry. Each module exports { summary, usage, run({ client, args }) }.
 * `args` is the parsed { _: positionals, flags } for the tokens after the command
 * name (see src/args.js).
 */

module.exports = {
  auth: require('./auth'),
  admin: require('./admin'),
  status: require('./status'),
  business: require('./business'),
  role: require('./role'),
  candidates: require('./candidates'),
  plan: require('./plan'),
  code: require('./code'),
  monitor: require('./monitor'),
  jobs: require('./jobs'),
  run: require('./run'),
};
