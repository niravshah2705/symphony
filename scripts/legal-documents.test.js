'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath));

test('deployed Terms is an exact byte-for-byte copy of EULA.md', () => {
  const source = read('EULA.md');
  const deployed = read('public/legal/terms.md');
  assert.equal(deployed.equals(source), true, 'public/legal/terms.md has drifted from EULA.md');
});

test('Privacy remains an English legal-review draft with every required disclosure', () => {
  const privacy = read('public/legal/privacy.md').toString('utf8');
  const requiredSections = [
    'Identity and authentication data',
    'Workspace and operational data',
    'Credentials and security',
    'Browser storage and essential functionality',
    'Optional Google Analytics 4 telemetry',
    'Third parties and data transfers',
    'Retention and deletion',
    'Your choices and requests',
    'Contact',
    'Draft and legal-review status',
  ];

  assert.match(privacy, /^# Privacy Notice$/m);
  assert.match(privacy, /English-language draft/i);
  assert.match(privacy, /qualified legal review/i);
  assert.match(privacy, /not legal advice/i);
  assert.match(privacy, /Nothing here claims compliance/i);
  assert.match(privacy, /`ai-fleet\.analytics-consent`/);
  assert.match(privacy, /enabled by default under the selected opt-out model/i);
  assert.match(privacy, /© 2026 Nirav Shah\. All rights reserved\./);

  for (const section of requiredSections) {
    assert.match(privacy, new RegExp(`^## \\d+\\. ${section}$`, 'm'), `missing disclosure: ${section}`);
  }
});
