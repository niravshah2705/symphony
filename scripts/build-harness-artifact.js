#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  assembleRegistry,
  buildHarnessArtifact,
  resolveSource,
  verifyRegistry,
} = require('./harness-registry/artifact-builder');

function parseOptions(argv) {
  const command = argv[0];
  if (!command || command.startsWith('--')) throw new Error('A command is required: resolve, build, assemble, or verify');
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value, got ${JSON.stringify(argument)}`);
    }
    const key = argument.slice(2);
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`Duplicate option: ${argument}`);
    options[key] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Missing --${name}`);
  return path.resolve(value);
}

function rejectUnexpected(options, allowed) {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`Unexpected option(s): ${unexpected.map((key) => `--${key}`).join(', ')}`);
}

function main(argv) {
  const { command, options } = parseOptions(argv);
  let result;
  if (command === 'resolve') {
    rejectUnexpected(options, ['sources', 'out']);
    result = resolveSource({ sourcesPath: required(options, 'sources'), outDir: required(options, 'out') });
  } else if (command === 'build') {
    rejectUnexpected(options, ['harness', 'source', 'archive', 'out', 'work']);
    if (!options.harness) throw new Error('Missing --harness');
    result = buildHarnessArtifact({
      harnessId: options.harness,
      sourcePath: required(options, 'source'),
      archivePath: required(options, 'archive'),
      outDir: required(options, 'out'),
      workDir: required(options, 'work'),
    });
  } else if (command === 'assemble') {
    rejectUnexpected(options, ['inputs', 'out']);
    result = assembleRegistry({ inputsDir: required(options, 'inputs'), outDir: required(options, 'out') });
  } else if (command === 'verify') {
    rejectUnexpected(options, ['registry']);
    result = verifyRegistry({ registryDir: required(options, 'registry') });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build-harness-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseOptions };
