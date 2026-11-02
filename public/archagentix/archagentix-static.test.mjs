import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Running ArchAgentix Benchmarks Static Tests...');

// 1. Verify HTML Structure
const htmlPath = path.join(__dirname, 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');
assert.ok(htmlContent.includes('ArchAgentix'), 'index.html missing ArchAgentix title');
assert.ok(htmlContent.includes('benchmarks-table'), 'index.html missing benchmarks table');
assert.ok(htmlContent.includes('evaluator'), 'index.html missing interactive evaluator section');
assert.ok(htmlContent.includes('slm-chat'), 'index.html missing SLM chat section');

// 2. Verify Static Master JSON Dataset from docs/model-pricing CSVs
const jsonPath = path.join(__dirname, '../data/benchmarks/index.json');
const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.ok(Array.isArray(jsonContent), 'index.json dataset must be an array');
assert.ok(jsonContent.length > 4000, `dataset must contain all model rows from CSVs (found ${jsonContent.length})`);

const firstModel = jsonContent[0];
assert.ok(firstModel.provider, 'model row missing provider');
assert.ok(firstModel.model_name, 'model row missing model_name');
assert.ok(firstModel.model_id, 'model row missing model_id');
assert.ok(firstModel.input_usd_per_1m !== undefined, 'model row missing input_usd_per_1m');
assert.ok(firstModel.output_usd_per_1m !== undefined, 'model row missing output_usd_per_1m');

// 3. Question Bank panel contract.
// The panel is a module page on platform.archagentix.com whose API lives on a
// different origin, so it reuses the SPA's auth bootstrap and API client. Those are
// public/js sources owned by other work: assert the exact import surface here so a
// rename fails this test instead of silently breaking sign-in in production.
const questionsPath = path.join(__dirname, 'questions.js');
const appPath = path.join(__dirname, 'app.js');
const questionsSource = fs.readFileSync(questionsPath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');

assert.ok(
  /<script\s+type="module"\s+src="\/archagentix\/app\.js">/.test(htmlContent),
  'index.html must load app.js as a root-absolute ES module — relative paths break without a trailing slash',
);
assert.ok(
  htmlContent.includes('href="/archagentix/styles.css"'),
  'index.html stylesheet must be root-absolute for the same reason',
);

for (const id of ['questions', 'questions-body', 'questions-drawer', 'questions-status']) {
  assert.ok(htmlContent.includes(`id="${id}"`), `index.html missing question bank node #${id}`);
}
assert.ok(htmlContent.includes('href="#questions"'), 'index.html nav must link to the question bank section');

const AUTH_EXPORTS = ['initializeAuthentication', 'getAuthenticationState', 'signIn', 'signInWithMicrosoft'];
const authSource = fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8');
for (const name of AUTH_EXPORTS) {
  assert.match(
    questionsSource,
    new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '/js/auth\\.js'`),
    `questions.js must import ${name} from the shared auth module rather than re-implementing sign-in`,
  );
  assert.match(authSource, new RegExp(`export (async )?function ${name}\\b`), `auth.js no longer exports ${name}`);
}
assert.match(
  questionsSource,
  /import \{ api \} from '\/js\/api\.js'/,
  "questions.js must import { api } from '/js/api.js'",
);

// Every bank call must have a caller and a client method: the panel edits the bank,
// the chat rail reads coverage. An orphan on either side would surface as a runtime
// TypeError in the browser, not at build time.
const apiSource = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
const agentViewSource = fs.readFileSync(path.join(__dirname, '../js/views/agent.js'), 'utf8');
const PANEL_CALLS = [
  ['listGlobalQuestions', questionsSource],
  ['createGlobalQuestion', questionsSource],
  ['updateGlobalQuestion', questionsSource],
  ['removeGlobalQuestion', questionsSource],
  ['assistGlobalQuestions', questionsSource],
  ['getQuestionCoverage', agentViewSource],
];
for (const [method, source] of PANEL_CALLS) {
  assert.match(source, new RegExp(`api\\.${method}\\(`), `nothing calls api.${method}`);
  assert.match(apiSource, new RegExp(`${method}:`), `api.js is missing ${method}`);
}

assert.match(
  questionsSource,
  /export async function initQuestionBank\b/,
  'questions.js must export initQuestionBank for app.js to boot',
);
assert.match(
  appSource,
  /import \{ initQuestionBank \} from '\.\/questions\.js'/,
  'app.js must boot the question bank',
);
assert.match(
  appSource,
  /initQuestionBank\(\)\.catch\(/,
  'app.js must not let a failed bank session take the benchmark tables down',
);

// Hosting serves /archagentix/*.js with its default long cache unless firebase.json
// says otherwise, which would pin a stale panel in every already-open tab.
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../../firebase.json'), 'utf8'));
const archagentixHeader = (firebaseConfig.hosting.headers || []).find((entry) => entry.source === '/archagentix/**/*.@(css|js)');
assert.ok(archagentixHeader, 'firebase.json must no-cache /archagentix css and js');
assert.equal(archagentixHeader.headers[0].key, 'Cache-Control');
assert.equal(archagentixHeader.headers[0].value, 'no-cache');

console.log('✅ All ArchAgentix Static Tests Passed Successfully!');
