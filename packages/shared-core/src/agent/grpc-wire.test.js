'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wire = require('./grpc-wire');

test('pbString/pbMessage round-trip through decodeFields', () => {
  const buf = Buffer.concat([wire.pbString(1, 'hello'), wire.pbString(2, 'ns/ate')]);
  const fields = wire.decodeFields(buf);
  assert.equal(wire.getString(fields, 1), 'hello');
  assert.equal(wire.getString(fields, 2), 'ns/ate');
});

test('pbMapStringString encodes entries decoded back to a plain object', () => {
  const buf = wire.pbMapStringString(5, { A: '1', B: 'two' });
  const fields = wire.decodeFields(buf);
  const map = wire.getMapStringString(fields, 5);
  assert.deepEqual(map, { A: '1', B: 'two' });
});

test('pbVarint + getVarint preserve numeric field values', () => {
  const buf = wire.pbVarint(6, 12);
  const fields = wire.decodeFields(buf);
  assert.equal(wire.getVarint(fields, 6), 12);
  // Zero / false are omitted (proto3 default elision).
  assert.equal(wire.pbVarint(6, 0).length, 0);
});

test('grpc frame + unframe is lossless', () => {
  const payload = Buffer.from('abcdefgh');
  const framed = wire.frameGrpcMessage(payload);
  assert.equal(framed[0], 0); // uncompressed
  assert.equal(framed.readUInt32BE(1), payload.length);
  const messages = wire.unframeGrpcMessages(framed);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.toString(), 'abcdefgh');
});

test('empty pbString/pbMessage are elided', () => {
  assert.equal(wire.pbString(1, '').length, 0);
  assert.equal(wire.pbString(1, null).length, 0);
  assert.equal(wire.pbMessage(2, [Buffer.alloc(0)]).length, 0);
});
