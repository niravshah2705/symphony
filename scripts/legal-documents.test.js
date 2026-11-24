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

// The privacy notice is the document an underwriter and a Data Principal read to
// learn what we do with personal data, so the gate here is the disclosure list
// itself: Rule 3 (itemised data per purpose, withdrawal as easy as consent, the
// route to the Board), Rule 6 (safeguards), Rule 7 (breach intimation and the
// 72-hour report), Rule 9 (a published contact who answers), section 9 (children)
// and Rule 15 (transfer outside India). A section that gets dropped in a later
// rewrite should fail here rather than in a regulatory response.
test('Privacy notice makes every disclosure the DPDP Act and Rules call for', () => {
  const privacy = read('public/legal/privacy.md').toString('utf8');
  const requiredSections = [
    'Who we are, and your two possible relationships with us',
    'The personal data we handle, and the purpose of each',
    'Consent, and how you take it back',
    'Identity and authentication data',
    'Workspace and operational data',
    'Credentials and security safeguards',
    'Browser storage, cookies and essential functionality',
    'Optional Google Analytics 4 telemetry',
    'Who else handles data',
    'Transfers of personal data outside India',
    'How long we keep it, and deletion',
    'Your rights, and how to exercise each',
    'Children',
    'If our security fails: breach notification',
    'Changes to this notice',
    'Questions and grievances',
  ];

  assert.match(privacy, /^# Privacy Notice$/m);
  for (const section of requiredSections) {
    assert.match(privacy, new RegExp(`^## \\d+\\. ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `missing disclosure: ${section}`);
  }
  const numbered = [...privacy.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(
    numbered.map((entry) => entry[0]),
    numbered.map((_, i) => i + 1),
    'section numbers must run 1..N without gaps or repeats',
  );
  assert.deepEqual(
    numbered.map((entry) => entry[1]),
    requiredSections,
    'the notice sections, in order, must match this disclosure list',
  );

  // Rule 3(b): an itemised description of the data beside the purpose for each.
  assert.match(privacy, /^\| Personal data \| Specified purpose \|$/m, 'data and purposes must be itemised as a table');
  assert.ok((privacy.match(/^\| --- \| --- \|$/gm) || []).length === 1, 'exactly one data/purpose table');
  // Rule 3(c)(i): withdrawal comparable to the ease of giving consent.
  assert.match(privacy, /[Ww]ithdrawal is as easy as giving it/);
  // Rule 3(c)(iii): the notice must say how to complain to the Board.
  assert.match(privacy, /Data Protection Board of India/);
  // Rule 9: a published business contact for processing questions, in the notice
  // and repeated in every rights response.
  assert.match(privacy, /Grievance Officer, Archagentix Private Limited/);
  assert.match(privacy, /These details appear in every response/);
  // Rule 7: both intimation duties, with the only number the Rule actually sets.
  assert.match(privacy, /seventy-two hours/);
  assert.match(privacy, /To you, without delay/);
  // Rule 6: safeguards, including the one-year log retention and processor terms.
  assert.match(privacy, /one year/);
  assert.match(privacy, /written agreement with each processor/i);
  // Section 9 of the Act: a child is under eighteen, and no tracking or targeted
  // advertising at children.
  assert.match(privacy, /not completed eighteen years of age/);
  assert.match(privacy, /do not track or behaviourally monitor children/i);
  // Rule 15 and section 16: transfer out of India is stated, not implied.
  assert.match(privacy, /`us-central1`/);
  assert.match(privacy, /unless the Central Government restricts/);
  // Rights with a route to exercise them and the identifiers we need (Rule 14(1)).
  for (const right of ['access', 'correct or complete', 'erase', 'withdraw consent', 'nominate', 'grieve']) {
    assert.ok(privacy.includes(`**${right}**`), `right to ${right} must be a named, bolded request`);
  }
  assert.match(privacy, /What we need from you/);

  assert.match(privacy, /`ai-fleet\.analytics-consent`/);
  assert.match(privacy, /on by default/);
  assert.match(privacy, /© 2026 Archagentix Private Limited\. All rights reserved\./);
});

// A published policy page must not advertise itself as unfinished. These were the
// pre-publication template banners; if one returns, it undercuts the document it
// sits on and reads to a card acquirer as an unadopted draft.
test('the documents publish as final terms, with no template or review banners', () => {
  for (const file of ['EULA.md', 'public/legal/terms.md', 'public/legal/privacy.md', 'public/legal/refund.md', 'public/legal/shipping.md']) {
    const text = read(file).toString('utf8');
    assert.doesNotMatch(text, /not legal advice/i, `${file} still disclaims itself`);
    assert.doesNotMatch(text, /qualified legal review/i, `${file} still awaits legal review`);
    assert.doesNotMatch(text, /Template notice/i, `${file} still carries the template banner`);
    assert.doesNotMatch(text, /English-language draft/i, `${file} still calls itself a draft`);
  }
});

// Card acquirers crawl the public site before enabling international payments, and
// the identity they read there must be the incorporated entity. A personal name or
// a free-mailbox address on a policy page reads as an unincorporated side project.
test('published legal documents name the company, never an individual', () => {
  for (const file of ['EULA.md', 'public/legal/terms.md', 'public/legal/privacy.md']) {
    const text = read(file).toString('utf8');
    assert.doesNotMatch(text, /Nirav Shah/, `${file} still names an individual`);
    assert.doesNotMatch(text, /@[a-z0-9.-]*gmail\.com/i, `${file} still publishes a gmail address`);
    assert.match(text, /Archagentix Private Limited/, `${file} must name the legal entity`);
  }
});
