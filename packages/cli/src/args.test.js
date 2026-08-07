'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('./args');

test('parses positionals', () => {
  const { _, flags } = parseArgs(['create', 'proj-123']);
  assert.deepEqual(_, ['create', 'proj-123']);
  assert.deepEqual(flags, {});
});

test('parses --flag value', () => {
  const { flags } = parseArgs(['--name', 'OTA Test']);
  assert.equal(flags.name, 'OTA Test');
});

test('parses --flag=value', () => {
  const { flags } = parseArgs(['--api=http://localhost:5000']);
  assert.equal(flags.api, 'http://localhost:5000');
});

test('treats a bare --flag at end of argv as boolean true', () => {
  const { flags } = parseArgs(['--no-follow']);
  assert.equal(flags['no-follow'], true);
});

test('treats --flag followed by another --flag as boolean true', () => {
  const { flags } = parseArgs(['--new-project', '--team', 't1']);
  assert.equal(flags['new-project'], true);
  assert.equal(flags.team, 't1');
});

test('mixes positionals and flags in any order', () => {
  const { _, flags } = parseArgs(['assume', 'user-1', '--json']);
  assert.deepEqual(_, ['assume', 'user-1']);
  assert.equal(flags.json, true);
});

test('everything after a lone -- is positional', () => {
  const { _, flags } = parseArgs(['plan', '--', '--not-a-flag']);
  assert.deepEqual(_, ['plan', '--not-a-flag']);
  assert.deepEqual(flags, {});
});

test('empty argv yields empty result', () => {
  assert.deepEqual(parseArgs([]), { _: [], flags: {} });
  assert.deepEqual(parseArgs(), { _: [], flags: {} });
});
