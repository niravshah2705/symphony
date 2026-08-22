'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSION, MAX_TEXTS_PER_BATCH } = require('./embed');

function fakeFetch({ status = 200, dimension = EMBEDDING_DIMENSION } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) {
      return { ok: false, status, text: async () => 'boom' };
    }
    const requests = JSON.parse(init.body).requests;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: requests.map((_, i) => ({ values: new Array(dimension).fill(0).map((_, j) => (i + 1) * 0.01 + j * 0.0001) })),
      }),
    };
  };
  return { fetchImpl, calls };
}

test('embedTexts returns [] without making a request for an empty input', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const vectors = await embedTexts([], { apiKey: 'k', fetchImpl });
  assert.deepEqual(vectors, []);
  assert.equal(calls.length, 0);
});

test('embedTexts posts one vector per input text, in order, at the configured dimension', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const vectors = await embedTexts(['a', 'b', 'c'], { apiKey: 'k', fetchImpl });
  assert.equal(vectors.length, 3);
  assert.equal(vectors[0].length, EMBEDDING_DIMENSION);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`models/${EMBEDDING_MODEL}:batchEmbedContents$`));
  assert.equal(calls[0].body.requests.length, 3);
  assert.equal(calls[0].body.requests[0].content.parts[0].text, 'a');
  assert.equal(calls[0].body.requests[0].embedContentConfig.outputDimensionality, EMBEDDING_DIMENSION);
});

test('embedTexts batches beyond MAX_TEXTS_PER_BATCH into multiple requests', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const texts = new Array(MAX_TEXTS_PER_BATCH + 1).fill('x');
  const vectors = await embedTexts(texts, { apiKey: 'k', fetchImpl });
  assert.equal(vectors.length, texts.length);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.requests.length, MAX_TEXTS_PER_BATCH);
  assert.equal(calls[1].body.requests.length, 1);
});

test('embedTexts sends the sentinel token instead of the real key when EGRESS_PROXY_URL is set', async () => {
  const originalUrl = process.env.EGRESS_PROXY_URL;
  process.env.EGRESS_PROXY_URL = 'https://proxy.internal';
  try {
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('./embed')];
    const { embedTexts: embedTextsProxied } = require('./embed');
    const { fetchImpl, calls } = fakeFetch();
    await embedTextsProxied(['hello'], { apiKey: 'real-secret-key', fetchImpl });
    assert.notEqual(calls[0].init.headers['x-goog-api-key'], 'real-secret-key');
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'egress-proxy-sentinel');
  } finally {
    if (originalUrl === undefined) delete process.env.EGRESS_PROXY_URL;
    else process.env.EGRESS_PROXY_URL = originalUrl;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('./embed')];
  }
});

test('embedTexts throws with response detail on a non-ok response', async () => {
  const { fetchImpl } = fakeFetch({ status: 500 });
  await assert.rejects(() => embedTexts(['x'], { apiKey: 'k', fetchImpl }), /embeddings request failed \(500\)/);
});
