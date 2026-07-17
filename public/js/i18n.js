import { api } from './api.js';

const STORAGE_KEY = 'ai-fleet.locale';
const DEFAULT_LOCALE = 'en';
const MAX_SUGGESTIONS = 5;
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
const TRANSLATABLE_ATTRIBUTES = Object.freeze(['placeholder', 'title', 'aria-label', 'aria-description', 'alt']);

const FALLBACK_LOCALES = Object.freeze([
  { tag: 'en', label: 'English', nativeLabel: 'English' },
  { tag: 'gu-IN', label: 'Gujarati', nativeLabel: 'ગુજરાતી' },
  { tag: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी' },
]);

const MESSAGES = Object.freeze({
  en: {
    language: 'Language',
    skipWorkspace: 'Skip to workspace',
    openNavigation: 'Open navigation',
    closeNavigation: 'Close navigation',
    collapseNavigation: 'Collapse navigation',
    expandNavigation: 'Expand navigation',
    primaryNavigation: 'Primary navigation',
    application: 'Application',
    workspace: 'Workspace',
    agentOperations: 'Agent operations',
    workspaceSection: 'Workspace',
    agentWorkspace: 'Agent workspace',
    agentWorkspaceSub: 'Plan and run work',
    agentJobs: 'Agent jobs',
    agentJobsSub: 'Planner and coding history',
    agentJobsDelete: 'Delete',
    agentJobsConfirmDelete: 'Confirm delete',
    agentJobsClearFinished: 'Clear finished',
    agentJobsConfirmClear: 'Confirm clear',
    agentPaused: 'Paused',
    agentPlanningPaused: 'Planning is paused',
    agentJobActivity: 'See activity',
    agentPauseGitTitle: 'Automatic work is waiting for a code connection.',
    agentPauseGitBody: 'Nothing new will start until GitHub or GitLab is connected and ready. Queued work is safe.',
    agentPauseGitAction: 'Check code connection',
    agentPauseGitJob: 'This job stopped because the code connection was unavailable.',
    agentPauseModelTitle: 'Automatic work is waiting for an AI model.',
    agentPauseModelBody: 'Nothing new will start until the selected model is available. Queued work is safe.',
    agentPauseModelAction: 'Check model setup',
    agentPauseModelJob: 'This job stopped because the selected model was unavailable.',
    agentPauseTitle: 'Automatic work is paused for now.',
    agentPauseBody: 'Nothing new will start until the workspace is ready. Queued work is safe.',
    agentPauseAction: 'Review workspace setup',
    agentPauseJob: 'This job stopped because the workspace was unavailable.',
    callRecorder: 'Call recorder',
    callRecorderSub: 'Capture agent sessions',
    traceAnalysis: 'Trace analysis',
    traceAnalysisSub: 'Understand what happened',
    planning: 'Planning',
    business: 'Business',
    businessSub: 'Contexts and roles',
    projects: 'Projects',
    projectsSub: 'Plans and milestones',
    board: 'Board',
    boardSub: 'Issues in motion',
    insights: 'Insights',
    analytics: 'Analytics',
    analyticsSub: 'Cost and performance',
    workflows: 'Workflows',
    workflowsSub: 'Patterns and orchestration',
    system: 'System',
    troubleshooting: 'Troubleshooting',
    troubleshootingSub: 'Diagnose connections',
    settings: 'Settings',
    settingsSub: 'Models and connections',
    workspaceReady: 'Workspace ready',
    localTools: 'Local models and connected tools',
    checking: 'Checking…',
    setupNeeded: 'Setup needed',
    needsAttention: 'Needs attention',
    connected: 'Connected',
    translationUnavailable: 'Local translation is temporarily unavailable',
    actingAs: 'Acting as {name}',
    security: 'Security',
    authentication: 'Authentication',
    signIn: 'Sign in',
    signOut: 'Sign out',
    signedInUser: 'Signed-in user',
    auth0Account: 'Auth0 account',
    protectedWorkspace: 'Protected workspace',
    authLoadingTitle: 'Checking your session',
    authLoading: 'Restoring secure session…',
    authTitle: 'Sign in to AI Fleet',
    authDescription: 'Use your organization account to access this workspace.',
    continueWithAuth0: 'Continue with Auth0',
    whySignIn: 'Why do I need to sign in?',
    authDetails: 'In production, Auth0 signs you in and Istio verifies your access token before any workspace request reaches AI Fleet.',
    authenticationFailed: 'We could not verify your session. Try signing in again.',
    sessionExpired: 'Your session expired. Sign in again to continue.',
    details: 'Details',
    retry: 'Retry',
  },
  gu: {
    language: 'ભાષા',
    skipWorkspace: 'કાર્યસ્થળ પર જાઓ',
    openNavigation: 'નેવિગેશન ખોલો',
    closeNavigation: 'નેવિગેશન બંધ કરો',
    collapseNavigation: 'નેવિગેશન સંકોચો',
    expandNavigation: 'નેવિગેશન વિસ્તારો',
    primaryNavigation: 'મુખ્ય નેવિગેશન',
    application: 'એપ્લિકેશન',
    workspace: 'કાર્યસ્થળ',
    agentOperations: 'એજન્ટ કામગીરી',
    workspaceSection: 'કાર્યસ્થળ',
    agentWorkspace: 'એજન્ટ કાર્યસ્થળ',
    agentWorkspaceSub: 'કાર્યની યોજના બનાવો અને ચલાવો',
    agentJobs: 'એજન્ટ જોબ્સ',
    agentJobsSub: 'યોજના અને કોડિંગનો ઇતિહાસ',
    agentJobsDelete: 'કાઢી નાખો',
    agentJobsConfirmDelete: 'કાઢી નાખવાની પુષ્ટિ કરો',
    agentJobsClearFinished: 'પૂર્ણ થયેલ જોબ્સ સાફ કરો',
    agentJobsConfirmClear: 'સાફ કરવાની પુષ્ટિ કરો',
    agentPaused: 'થોભાવેલ',
    agentPlanningPaused: 'આયોજન થોભાવેલ છે',
    agentJobActivity: 'પ્રવૃત્તિ જુઓ',
    agentPauseGitTitle: 'સ્વચાલિત કાર્ય કોડ કનેક્શનની રાહ જોઈ રહ્યું છે.',
    agentPauseGitBody: 'GitHub અથવા GitLab જોડાયેલ અને તૈયાર થાય ત્યાં સુધી નવું કાર્ય શરૂ થશે નહીં. કતારમાં રહેલું કાર્ય સુરક્ષિત છે.',
    agentPauseGitAction: 'કોડ કનેક્શન તપાસો',
    agentPauseGitJob: 'કોડ કનેક્શન ઉપલબ્ધ ન હોવાથી આ જોબ અટકી ગઈ.',
    agentPauseModelTitle: 'સ્વચાલિત કાર્ય AI મોડેલની રાહ જોઈ રહ્યું છે.',
    agentPauseModelBody: 'પસંદ કરેલું મોડેલ ઉપલબ્ધ થાય ત્યાં સુધી નવું કાર્ય શરૂ થશે નહીં. કતારમાં રહેલું કાર્ય સુરક્ષિત છે.',
    agentPauseModelAction: 'મોડેલ સેટઅપ તપાસો',
    agentPauseModelJob: 'પસંદ કરેલું મોડેલ ઉપલબ્ધ ન હોવાથી આ જોબ અટકી ગઈ.',
    agentPauseTitle: 'સ્વચાલિત કાર્ય હમણાં થોભાવેલ છે.',
    agentPauseBody: 'કાર્યસ્થળ તૈયાર થાય ત્યાં સુધી નવું કાર્ય શરૂ થશે નહીં. કતારમાં રહેલું કાર્ય સુરક્ષિત છે.',
    agentPauseAction: 'કાર્યસ્થળ સેટઅપ તપાસો',
    agentPauseJob: 'કાર્યસ્થળ ઉપલબ્ધ ન હોવાથી આ જોબ અટકી ગઈ.',
    callRecorder: 'કૉલ રેકોર્ડર',
    callRecorderSub: 'એજન્ટ સત્રો રેકોર્ડ કરો',
    traceAnalysis: 'ટ્રેસ વિશ્લેષણ',
    traceAnalysisSub: 'શું થયું તે સમજો',
    planning: 'આયોજન',
    business: 'વ્યવસાય',
    businessSub: 'સંદર્ભો અને ભૂમિકાઓ',
    projects: 'પ્રોજેક્ટ્સ',
    projectsSub: 'યોજનાઓ અને માઇલસ્ટોન્સ',
    board: 'બોર્ડ',
    boardSub: 'પ્રગતિમાં રહેલા મુદ્દાઓ',
    insights: 'આંતરદૃષ્ટિ',
    analytics: 'વિશ્લેષણ',
    analyticsSub: 'ખર્ચ અને કામગીરી',
    workflows: 'કાર્યપ્રવાહો',
    workflowsSub: 'પેટર્ન અને સંકલન',
    system: 'સિસ્ટમ',
    troubleshooting: 'સમસ્યા નિવારણ',
    troubleshootingSub: 'જોડાણોનું નિદાન',
    settings: 'સેટિંગ્સ',
    settingsSub: 'મોડેલો અને જોડાણો',
    workspaceReady: 'કાર્યસ્થળ તૈયાર છે',
    localTools: 'સ્થાનિક મોડેલો અને જોડાયેલા સાધનો',
    checking: 'તપાસી રહ્યું છે…',
    setupNeeded: 'સેટઅપ જરૂરી છે',
    needsAttention: 'ધ્યાન આપવું જરૂરી છે',
    connected: 'જોડાયેલ છે',
    translationUnavailable: 'સ્થાનિક અનુવાદ હાલમાં ઉપલબ્ધ નથી',
    actingAs: '{name} તરીકે કાર્યરત',
    security: 'સુરક્ષા',
    authentication: 'પ્રમાણીકરણ',
    signIn: 'સાઇન ઇન',
    signOut: 'સાઇન આઉટ',
    signedInUser: 'સાઇન ઇન કરેલ વપરાશકર્તા',
    auth0Account: 'Auth0 ખાતું',
    protectedWorkspace: 'સુરક્ષિત કાર્યસ્થળ',
    authLoadingTitle: 'તમારા સત્રની તપાસ થઈ રહી છે',
    authLoading: 'સુરક્ષિત સત્ર પુનઃસ્થાપિત થઈ રહ્યું છે…',
    authTitle: 'AI Fleet માં સાઇન ઇન કરો',
    authDescription: 'આ કાર્યસ્થળ ઍક્સેસ કરવા માટે તમારા સંસ્થાના ખાતાનો ઉપયોગ કરો.',
    continueWithAuth0: 'Auth0 વડે આગળ વધો',
    whySignIn: 'મારે સાઇન ઇન શા માટે કરવું જરૂરી છે?',
    authDetails: 'પ્રોડક્શનમાં Auth0 તમને સાઇન ઇન કરાવે છે અને કાર્યસ્થળની કોઈપણ વિનંતી AI Fleet સુધી પહોંચે તે પહેલાં Istio તમારા ઍક્સેસ ટોકનની ચકાસણી કરે છે.',
    authenticationFailed: 'અમે તમારા સત્રની ચકાસણી કરી શક્યા નથી. ફરી સાઇન ઇન કરવાનો પ્રયાસ કરો.',
    sessionExpired: 'તમારા સત્રની મુદત પૂરી થઈ ગઈ છે. આગળ વધવા માટે ફરી સાઇન ઇન કરો.',
    details: 'વિગતો',
    retry: 'ફરી પ્રયાસ કરો',
  },
  hi: {
    language: 'भाषा',
    skipWorkspace: 'कार्यक्षेत्र पर जाएँ',
    openNavigation: 'नेविगेशन खोलें',
    closeNavigation: 'नेविगेशन बंद करें',
    collapseNavigation: 'नेविगेशन संक्षिप्त करें',
    expandNavigation: 'नेविगेशन विस्तृत करें',
    primaryNavigation: 'मुख्य नेविगेशन',
    application: 'एप्लिकेशन',
    workspace: 'कार्यक्षेत्र',
    agentOperations: 'एजेंट संचालन',
    workspaceSection: 'कार्यक्षेत्र',
    agentWorkspace: 'एजेंट कार्यक्षेत्र',
    agentWorkspaceSub: 'काम की योजना बनाएँ और चलाएँ',
    agentJobs: 'एजेंट जॉब्स',
    agentJobsSub: 'योजना और कोडिंग का इतिहास',
    agentJobsDelete: 'हटाएँ',
    agentJobsConfirmDelete: 'हटाने की पुष्टि करें',
    agentJobsClearFinished: 'पूर्ण जॉब्स साफ़ करें',
    agentJobsConfirmClear: 'साफ़ करने की पुष्टि करें',
    agentPaused: 'रुका हुआ',
    agentPlanningPaused: 'योजना रुकी हुई है',
    agentJobActivity: 'गतिविधि देखें',
    agentPauseGitTitle: 'स्वचालित काम कोड कनेक्शन की प्रतीक्षा कर रहा है।',
    agentPauseGitBody: 'GitHub या GitLab के जुड़ने और तैयार होने तक नया काम शुरू नहीं होगा। कतार में रखा काम सुरक्षित है।',
    agentPauseGitAction: 'कोड कनेक्शन जाँचें',
    agentPauseGitJob: 'कोड कनेक्शन उपलब्ध न होने के कारण यह जॉब रुक गई।',
    agentPauseModelTitle: 'स्वचालित काम AI मॉडल की प्रतीक्षा कर रहा है।',
    agentPauseModelBody: 'चुना गया मॉडल उपलब्ध होने तक नया काम शुरू नहीं होगा। कतार में रखा काम सुरक्षित है।',
    agentPauseModelAction: 'मॉडल सेटअप जाँचें',
    agentPauseModelJob: 'चुना गया मॉडल उपलब्ध न होने के कारण यह जॉब रुक गई।',
    agentPauseTitle: 'स्वचालित काम अभी रुका हुआ है।',
    agentPauseBody: 'कार्यक्षेत्र तैयार होने तक नया काम शुरू नहीं होगा। कतार में रखा काम सुरक्षित है।',
    agentPauseAction: 'कार्यक्षेत्र सेटअप देखें',
    agentPauseJob: 'कार्यक्षेत्र उपलब्ध न होने के कारण यह जॉब रुक गई।',
    callRecorder: 'कॉल रिकॉर्डर',
    callRecorderSub: 'एजेंट सत्र रिकॉर्ड करें',
    traceAnalysis: 'ट्रेस विश्लेषण',
    traceAnalysisSub: 'समझें कि क्या हुआ',
    planning: 'योजना',
    business: 'व्यवसाय',
    businessSub: 'संदर्भ और भूमिकाएँ',
    projects: 'प्रोजेक्ट',
    projectsSub: 'योजनाएँ और माइलस्टोन',
    board: 'बोर्ड',
    boardSub: 'प्रगति में मुद्दे',
    insights: 'अंतर्दृष्टि',
    analytics: 'विश्लेषण',
    analyticsSub: 'लागत और प्रदर्शन',
    workflows: 'कार्यप्रवाह',
    workflowsSub: 'पैटर्न और ऑर्केस्ट्रेशन',
    system: 'सिस्टम',
    troubleshooting: 'समस्या निवारण',
    troubleshootingSub: 'कनेक्शन का निदान',
    settings: 'सेटिंग्स',
    settingsSub: 'मॉडल और कनेक्शन',
    workspaceReady: 'कार्यक्षेत्र तैयार है',
    localTools: 'स्थानीय मॉडल और जुड़े उपकरण',
    checking: 'जाँच हो रही है…',
    setupNeeded: 'सेटअप आवश्यक है',
    needsAttention: 'ध्यान देने की आवश्यकता है',
    connected: 'कनेक्टेड',
    translationUnavailable: 'स्थानीय अनुवाद अभी उपलब्ध नहीं है',
    actingAs: '{name} के रूप में कार्यरत',
    security: 'सुरक्षा',
    authentication: 'प्रमाणीकरण',
    signIn: 'साइन इन',
    signOut: 'साइन आउट',
    signedInUser: 'साइन-इन किया हुआ उपयोगकर्ता',
    auth0Account: 'Auth0 खाता',
    protectedWorkspace: 'सुरक्षित कार्यक्षेत्र',
    authLoadingTitle: 'आपके सत्र की जाँच हो रही है',
    authLoading: 'सुरक्षित सत्र बहाल किया जा रहा है…',
    authTitle: 'AI Fleet में साइन इन करें',
    authDescription: 'इस कार्यक्षेत्र तक पहुँचने के लिए अपने संगठन के खाते का उपयोग करें।',
    continueWithAuth0: 'Auth0 के साथ जारी रखें',
    whySignIn: 'मुझे साइन इन करने की आवश्यकता क्यों है?',
    authDetails: 'प्रोडक्शन में Auth0 आपको साइन इन कराता है और किसी कार्यक्षेत्र अनुरोध के AI Fleet तक पहुँचने से पहले Istio आपके एक्सेस टोकन की जाँच करता है।',
    authenticationFailed: 'हम आपके सत्र की जाँच नहीं कर सके। फिर से साइन इन करने का प्रयास करें।',
    sessionExpired: 'आपके सत्र की अवधि समाप्त हो गई है। जारी रखने के लिए फिर से साइन इन करें।',
    details: 'विवरण',
    retry: 'पुनः प्रयास करें',
  },
});

let locale = normalizeLocale(readSavedLocale()) || DEFAULT_LOCALE;
let suggestions = [...FALLBACK_LOCALES];
let observer = null;
let translationTimer = null;
let translationGeneration = 0;
let localizationPasses = 0;
let fallbackRetryTimer = null;
let fallbackRetryAttempts = 0;
let translationDegraded = false;
const textSources = new WeakMap();
const textLocales = new WeakMap();
const attributeSources = new WeakMap();
const attributeLocales = new WeakMap();
const translationCache = new Map();

function readSavedLocale() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

export function normalizeLocale(value) {
  try {
    const [canonical] = Intl.getCanonicalLocales(String(value || '').trim());
    if (!canonical) return '';
    const language = new Intl.Locale(canonical).language;
    return ({ en: 'en', gu: 'gu-IN', hi: 'hi-IN', es: 'es', fr: 'fr', de: 'de', pt: 'pt-BR', ja: 'ja-JP', ar: 'ar' })[language] || '';
  } catch (_) {
    return '';
  }
}

function languageOf(value = locale) {
  try {
    return new Intl.Locale(value).language;
  } catch (_) {
    return 'en';
  }
}

export function getLocale() {
  return locale;
}

export function t(key, fallback = key, replacements = {}) {
  const language = languageOf();
  const template = (MESSAGES[language] && MESSAGES[language][key]) || MESSAGES.en[key] || fallback;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(replacements, name) ? String(replacements[name]) : `{${name}}`
  );
}

export function formatNumber(value, options = {}) {
  return new Intl.NumberFormat(locale, options).format(Number(value) || 0);
}

export function formatDate(value, options = { dateStyle: 'medium' }) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function applyDocumentLocale() {
  const language = languageOf();
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  document.body.dataset.locale = locale;
}

function applyStaticTranslations(root = document) {
  const nodes = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches('[data-i18n]')) nodes.push(root);
  root.querySelectorAll?.('[data-i18n]').forEach((node) => nodes.push(node));
  for (const node of nodes) {
    const key = node.dataset.i18n;
    const value = t(key, node.dataset.i18nFallback || node.textContent);
    const attribute = node.dataset.i18nAttr;
    if (attribute) {
      if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    } else if (node.textContent !== value) {
      node.textContent = value;
    }
  }
  document.querySelectorAll('#tabs a[data-route]').forEach((link) => {
    const strong = link.querySelector('.nav-link-copy strong');
    const label = strong?.textContent || '';
    // These attributes are observed below. Rewriting an unchanged value still
    // queues a MutationRecord in browsers, which would recursively schedule
    // localization passes and starve route rendering.
    if (link.title !== label) link.title = label;
    if (link.getAttribute('aria-label') !== label) link.setAttribute('aria-label', label);
  });
}

function looksTranslatable(value) {
  value = String(value || '').trim();
  if (!value || value.length < 2 || value.length > 1600) return false;
  if (/^(?:https?:\/\/|mailto:|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(value)) return false;
  if (/^[\d\s.,:;/%$€£₹+\-–—()[\]{}<>|]+$/.test(value)) return false;
  if (/^(?:[a-z0-9_.-]+\/){1,}[a-z0-9_.-]+$/i.test(value)) return false;
  return /\p{L}/u.test(value);
}

function shouldTranslateText(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest('script, style, code, pre, kbd, samp, textarea, input, [data-i18n], [data-i18n-skip], [data-user-content], .trace-raw')) return false;
  return looksTranslatable(node.nodeValue);
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (shouldTranslateText(node)) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function shouldTranslateAttribute(element, name) {
  if (!element.hasAttribute(name) || element.hasAttribute('data-i18n')) return false;
  if (element.closest('[data-i18n-skip], [data-user-content], .trace-raw')) return false;
  // Collapsed navigation titles are copied from the already-localized menu
  // label, so sending them through the model again would double-translate.
  if (name === 'title' && element.matches('#tabs a[data-route]')) return false;
  return looksTranslatable(element.getAttribute(name));
}

function collectAttributeTargets(root) {
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
  root.querySelectorAll?.('*').forEach((element) => elements.push(element));
  const targets = [];
  for (const element of elements) {
    for (const name of TRANSLATABLE_ATTRIBUTES) {
      if (shouldTranslateAttribute(element, name)) targets.push({ element, name });
    }
  }
  return targets;
}

function sourceText(node) {
  if (!textSources.has(node)) textSources.set(node, node.nodeValue);
  return textSources.get(node);
}

function weakAttributeMap(store, element) {
  if (!store.has(element)) store.set(element, new Map());
  return store.get(element);
}

function sourceAttribute(element, name) {
  const sources = weakAttributeMap(attributeSources, element);
  if (!sources.has(name)) sources.set(name, element.getAttribute(name));
  return sources.get(name);
}

function localeForTarget(target) {
  if (target.node) return textLocales.get(target.node);
  return weakAttributeMap(attributeLocales, target.element).get(target.name);
}

function applyTarget(target, value, targetLanguage) {
  if (target.node) {
    if (!target.node.isConnected) return;
    if (target.node.nodeValue !== value) target.node.nodeValue = value;
    textLocales.set(target.node, targetLanguage);
    return;
  }
  if (!target.element.isConnected) return;
  if (target.element.getAttribute(target.name) !== value) target.element.setAttribute(target.name, value);
  weakAttributeMap(attributeLocales, target.element).set(target.name, targetLanguage);
}

function restoreEnglish(root) {
  for (const node of collectTextNodes(root)) {
    if (textSources.has(node) && node.nodeValue !== textSources.get(node)) node.nodeValue = textSources.get(node);
    textLocales.set(node, 'en');
  }
  for (const { element, name } of collectAttributeTargets(root)) {
    const sources = attributeSources.get(element);
    if (sources?.has(name) && element.getAttribute(name) !== sources.get(name)) {
      element.setAttribute(name, sources.get(name));
    }
    weakAttributeMap(attributeLocales, element).set(name, 'en');
  }
}

function cachedTranslation(targetLocale, source) {
  return translationCache.get(`${targetLocale}\u0000${source}`);
}

async function translateDynamicText(root = document.body) {
  localizationPasses += 1;
  try {
    const targetLocale = locale;
    const language = languageOf(targetLocale);
    const generation = ++translationGeneration;
    if (language === 'en') {
      restoreEnglish(root);
      return;
    }

    const targets = [
      ...collectTextNodes(root).map((node) => ({ node })),
      ...collectAttributeTargets(root),
    ].filter((target) => localeForTarget(target) !== targetLocale);
    const bySource = new Map();
    for (const target of targets) {
      const source = target.node
        ? sourceText(target.node)
        : sourceAttribute(target.element, target.name);
      const cached = cachedTranslation(targetLocale, source);
      if (cached) {
        applyTarget(target, cached, targetLocale);
        continue;
      }
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push(target);
    }

    const entries = [...bySource.entries()];
    let usedFallback = false;
    for (let index = 0; index < entries.length; index += 40) {
      if (generation !== translationGeneration || locale !== targetLocale) return;
      const batch = entries.slice(index, index + 40);
      const sources = batch.map(([source]) => source);
      let response;
      try {
        response = await api.translateUi({ locale: targetLocale, texts: sources });
      } catch (_) {
        markTranslationDegraded();
        return;
      }
      const translated = Array.isArray(response.translations) ? response.translations : [];
      const fallback = response.fallback === true;
      if (fallback) usedFallback = true;
      for (let offset = 0; offset < batch.length; offset += 1) {
        const [source, sourceTargets] = batch[offset];
        const value = String(translated[offset] || source);
        if (!fallback) translationCache.set(`${targetLocale}\u0000${source}`, value);
        for (const target of sourceTargets) {
          if (locale !== targetLocale) continue;
          // A local-model outage must not make English sticky under a Gujarati
          // locale. Keep these targets eligible for the bounded retry below.
          applyTarget(target, value, fallback ? 'fallback' : targetLocale);
        }
      }
      if (fallback) break;
    }
    if (usedFallback) {
      markTranslationDegraded();
    } else if (root === document || root === document.body) {
      markTranslationHealthy();
    }
  } finally {
    localizationPasses -= 1;
    // Translation mutates text and attributes by design. Discard those records
    // so the observer only reacts to application content, not to our own pass.
    if (localizationPasses === 0) observer?.takeRecords();
  }
}

function markTranslationHealthy() {
  const changed = translationDegraded;
  translationDegraded = false;
  fallbackRetryAttempts = 0;
  window.clearTimeout(fallbackRetryTimer);
  fallbackRetryTimer = null;
  if (changed) renderLanguageControl();
}

function markTranslationDegraded() {
  if (!translationDegraded) {
    translationDegraded = true;
    renderLanguageControl();
  }
  if (fallbackRetryAttempts >= 4 || fallbackRetryTimer) return;
  const delay = Math.min(60_000, 16_000 * (2 ** fallbackRetryAttempts));
  fallbackRetryAttempts += 1;
  fallbackRetryTimer = window.setTimeout(() => {
    fallbackRetryTimer = null;
    translateDynamicText(document.body).catch(() => {});
  }, delay);
}

export function localize(root = document) {
  applyStaticTranslations(root);
  window.clearTimeout(translationTimer);
  translationTimer = window.setTimeout(() => translateDynamicText(root).catch(() => {}), 30);
}

function renderLanguageControl() {
  const host = document.getElementById('language-control');
  if (!host) return;
  host.dataset.i18nSkip = 'true';
  const select = document.createElement('select');
  select.id = 'language-select';
  select.className = 'language-select';
  select.setAttribute('aria-label', t('language'));

  const normalized = [];
  const seen = new Set();
  const saved = normalizeLocale(locale);
  const candidates = [...(suggestions.length ? suggestions : FALLBACK_LOCALES)];
  if (saved && !candidates.some((item) => normalizeLocale(item.tag) === saved)) {
    candidates.unshift({ tag: saved, label: saved, nativeLabel: saved });
  }
  for (const item of candidates) {
    const tag = normalizeLocale(item.tag);
    if (!tag || seen.has(tag) || normalized.length >= MAX_SUGGESTIONS) continue;
    seen.add(tag);
    normalized.push({ ...item, tag });
  }

  for (const item of normalized) {
    const option = document.createElement('option');
    option.value = item.tag;
    option.textContent = item.nativeLabel || item.label || item.tag;
    option.title = item.label || item.tag;
    option.selected = item.tag === locale;
    select.append(option);
  }
  select.addEventListener('change', () => setLocale(select.value));
  const warning = translationDegraded
    ? document.createElement('span')
    : null;
  if (warning) {
    warning.className = 'language-warning';
    warning.dataset.i18nSkip = 'true';
    warning.textContent = '⚠';
    warning.title = t('translationUnavailable');
    warning.setAttribute('aria-label', t('translationUnavailable'));
  }
  host.replaceChildren(select, ...(warning ? [warning] : []));
  host.title = t('language');
}

export async function setLocale(value, { persist = true } = {}) {
  const next = normalizeLocale(value) || DEFAULT_LOCALE;
  if (next === locale && document.documentElement.lang === next) return;
  locale = next;
  markTranslationHealthy();
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {
      // The in-memory selection remains active when browser storage is blocked.
    }
  }
  applyDocumentLocale();
  renderLanguageControl();
  localize(document);
  window.dispatchEvent(new CustomEvent('ai-fleet:locale-changed', { detail: { locale } }));
}

async function loadSuggestions() {
  try {
    const response = await api.getLocaleSuggestions(navigator.languages || [navigator.language]);
    if (Array.isArray(response.suggestions) && response.suggestions.length) {
      suggestions = response.suggestions.slice(0, MAX_SUGGESTIONS);
    }
    if (!normalizeLocale(readSavedLocale()) && response.locale) {
      locale = normalizeLocale(response.locale) || locale;
    }
  } catch (_) {
    suggestions = [...FALLBACK_LOCALES];
  }
}

function watchDynamicContent() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((records) => {
    if (localizationPasses > 0) return;
    if (!records.some((record) => record.addedNodes.length || record.type === 'characterData' || record.type === 'attributes')) return;
    for (const record of records) {
      if (record.type === 'characterData') {
        // Application-owned updates are new English source copy. Translation
        // writes never reach this branch because owned records are discarded.
        textSources.delete(record.target);
        textLocales.delete(record.target);
      } else if (record.type === 'attributes' && record.attributeName) {
        attributeSources.get(record.target)?.delete(record.attributeName);
        attributeLocales.get(record.target)?.delete(record.attributeName);
      }
    }
    localize(document.body);
  });
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
    subtree: true,
  });
}

export async function initializeI18n({ discover = true } = {}) {
  applyDocumentLocale();
  if (discover) await loadSuggestions();
  applyDocumentLocale();
  renderLanguageControl();
  localize(document);
  watchDynamicContent();
  return { locale, suggestions: [...suggestions] };
}
