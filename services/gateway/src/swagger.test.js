'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  docsAllowed,
  readDocsHeader,
  isApiDocsEnabled,
  API_DOCS_HEADER,
} = require('./swagger');

describe('swagger API docs gating', () => {
  describe('docsAllowed (pure decision)', () => {
    it('always allows in local dev regardless of header', () => {
      assert.equal(docsAllowed({ isCloud: false, headerValue: '' }), true);
      assert.equal(docsAllowed({ isCloud: false, headerValue: 'enabled' }), true);
      assert.equal(docsAllowed({ isCloud: false, headerValue: undefined }), true);
    });

    it('requires a non-empty header in cloud', () => {
      assert.equal(docsAllowed({ isCloud: true, headerValue: 'enabled' }), true);
      assert.equal(docsAllowed({ isCloud: true, headerValue: '1' }), true);
      assert.equal(docsAllowed({ isCloud: true, headerValue: 'anything' }), true);
    });

    it('denies in cloud when the header is missing, empty, or whitespace', () => {
      assert.equal(docsAllowed({ isCloud: true, headerValue: '' }), false);
      assert.equal(docsAllowed({ isCloud: true, headerValue: '   ' }), false);
      assert.equal(docsAllowed({ isCloud: true, headerValue: '\t\n' }), false);
      assert.equal(docsAllowed({ isCloud: true, headerValue: undefined }), false);
    });
  });

  describe('readDocsHeader', () => {
    it('reads via Express req.get()', () => {
      const req = { get: (name) => (name === API_DOCS_HEADER ? 'enabled' : '') };
      assert.equal(readDocsHeader(req), 'enabled');
    });

    it('falls back to req.headers when get() is absent', () => {
      const req = { headers: { [API_DOCS_HEADER]: 'enabled' } };
      assert.equal(readDocsHeader(req), 'enabled');
    });

    it('returns empty string for null/undefined/blank requests', () => {
      assert.equal(readDocsHeader(null), '');
      assert.equal(readDocsHeader(undefined), '');
      assert.equal(readDocsHeader({}), '');
    });
  });

  describe('isApiDocsEnabled', () => {
    // Unit tests run without MESSAGING_MODE=pubsub, so IS_CLOUD is false and
    // docs are always enabled here. This asserts the dev default holds and that
    // the function tolerates odd request shapes without throwing.
    it('is enabled in the local/dev test environment', () => {
      assert.equal(isApiDocsEnabled({ get: () => '' }), true);
      assert.equal(isApiDocsEnabled(null), true);
      assert.equal(isApiDocsEnabled(undefined), true);
    });
  });

  describe('API_DOCS_HEADER constant', () => {
    it('is the expected lowercase header name', () => {
      assert.equal(API_DOCS_HEADER, 'x-ai-fleet-api-docs');
      assert.equal(API_DOCS_HEADER, API_DOCS_HEADER.toLowerCase());
    });
  });
});
