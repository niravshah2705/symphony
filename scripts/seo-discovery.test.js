'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const readPublic = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

test('SPA publishes complete ADLC search metadata and valid JSON-LD', () => {
  const html = readPublic('index.html');
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/s)?.[1];

  assert.ok(description, 'meta description must be present');
  assert.match(description, /ADLC \(Agentic Development Life Cycle\)/);
  assert.ok(description.length >= 120 && description.length <= 170, `unexpected description length: ${description.length}`);
  assert.match(html, /<link rel="canonical" href="https:\/\/adlc-9e72f\.web\.app\/" \/>/);
  assert.match(html, /<link rel="describedby" type="text\/markdown" href="\/llms\.txt" \/>/);
  assert.doesNotMatch(html, /<link rel="alternate"[^>]+href="\/llms\.txt"/);

  const jsonLdSource = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(jsonLdSource, 'JSON-LD block must be present');
  const jsonLd = JSON.parse(jsonLdSource);
  const types = new Set(jsonLd['@graph'].map((item) => item['@type']));
  assert.deepEqual(types, new Set(['WebSite', 'SoftwareApplication', 'DefinedTerm']));
  const term = jsonLd['@graph'].find((item) => item['@type'] === 'DefinedTerm');
  const application = jsonLd['@graph'].find((item) => item['@type'] === 'SoftwareApplication');
  assert.equal(term.name, 'ADLC');
  assert.match(term.description, /Agentic Development Life Cycle/);
  assert.equal(application.name, 'AI Fleet');
  assert.equal(application.about['@id'], term['@id']);
});

test('robots policy is valid, AI-crawler explicit, and points to the canonical sitemap', () => {
  const robots = readPublic('robots.txt');
  const agents = [
    'OAI-SearchBot', 'ChatGPT-User', 'GPTBot',
    'Claude-SearchBot', 'Claude-User', 'ClaudeBot',
    'Googlebot', 'Google-Extended',
    'PerplexityBot', 'Perplexity-User',
  ];

  assert.doesNotMatch(robots, /<!DOCTYPE|<html/i);
  for (const agent of agents) {
    assert.match(robots, new RegExp(`User-agent: ${agent}\\nAllow: /\\nDisallow: /api/`));
  }
  assert.match(robots, /User-agent: \*\nAllow: \/\nDisallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/adlc-9e72f\.web\.app\/sitemap\.xml/);
});

test('sitemap and language-model documents expose one canonical public source', () => {
  const sitemap = readPublic('sitemap.xml');
  const concise = readPublic('llms.txt');
  const full = readPublic('llms-full.txt');

  assert.match(sitemap, /<loc>https:\/\/adlc-9e72f\.web\.app\/<\/loc>/);
  assert.doesNotMatch(sitemap, /<loc>[^<]*#/);
  assert.equal((sitemap.match(/<url>/g) || []).length, 1, 'hash routes must not masquerade as crawlable URLs');
  for (const content of [concise, full]) {
    assert.match(content, /ADLC/);
    assert.match(content, /Agentic Development Life Cycle/);
    assert.match(content, /https:\/\/adlc-9e72f\.web\.app\//);
  }
  assert.match(concise, /Full ADLC overview/);
  assert.doesNotMatch(concise, /^## Core facts$/m);
  assert.match(full, /human-governed/i);
});

test('compact ADLC launcher has four named, local-icon assistant links', () => {
  const html = readPublic('index.html');
  const assistants = [...html.matchAll(/data-ai-assistant="([^"]+)"/g)].map((match) => match[1]);
  const icons = [...html.matchAll(/data-brand-icon="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(assistants, ['ChatGPT', 'Claude', 'Gemini', 'Perplexity']);
  assert.deepEqual(icons, ['openai', 'anthropic', 'gemini', 'perplexity']);
  assert.equal((html.match(/class="adlc-ai-links"/g) || []).length, 1);
  assert.match(html, /Explain ADLC \(Agentic Development Life Cycle\).*llms-full\.txt/);
  assert.equal((html.match(/aria-label="Copy an ADLC prompt and open [^"]+"/g) || []).length, 4);
});
