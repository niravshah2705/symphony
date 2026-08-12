import { api } from './api.js';

const STORAGE_KEY = 'ai-fleet.locale';
const DEFAULT_LOCALE = 'en';
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
const TRANSLATABLE_ATTRIBUTES = Object.freeze(['placeholder', 'title', 'aria-label', 'aria-description', 'alt']);

export const LANGUAGE_GROUPS = Object.freeze([
  Object.freeze({ key: 'regionalLanguages', items: Object.freeze([
    Object.freeze({ tag: 'gu-IN', label: 'Gujarati', nativeLabel: 'ગુજરાતી' }),
    Object.freeze({ tag: 'mr-IN', label: 'Marathi', nativeLabel: 'मराठी' }),
  ]) }),
  Object.freeze({ key: 'nationalLanguages', items: Object.freeze([
    Object.freeze({ tag: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी' }),
  ]) }),
  Object.freeze({ key: 'internationalLanguages', items: Object.freeze([
    Object.freeze({ tag: 'en', label: 'English', nativeLabel: 'English' }),
  ]) }),
  Object.freeze({ key: 'otherLanguages', items: Object.freeze([
    Object.freeze({ tag: 'es', label: 'Spanish', nativeLabel: 'Español' }),
    Object.freeze({ tag: 'fr', label: 'French', nativeLabel: 'Français' }),
    Object.freeze({ tag: 'de', label: 'German', nativeLabel: 'Deutsch' }),
    Object.freeze({ tag: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português (Brasil)' }),
    Object.freeze({ tag: 'ja-JP', label: 'Japanese', nativeLabel: '日本語' }),
    Object.freeze({ tag: 'ar', label: 'Arabic', nativeLabel: 'العربية' }),
  ]) }),
]);

const ALL_LOCALES = Object.freeze(LANGUAGE_GROUPS.flatMap((group) => group.items));

const MESSAGES = Object.freeze({
  en: {
    language: 'Language',
    accountAndContext: 'Account and context',
    aiFleetProject: 'AI Fleet project',
    noOrganization: 'No organization available',
    noAiFleetProject: 'No AI Fleet project available',
    contextUnavailable: 'Organization context is temporarily unavailable.',
    regionalLanguages: 'Regional',
    nationalLanguages: 'National',
    internationalLanguages: 'International',
    otherLanguages: 'Others',
    recommended: 'Recommended',
    invitation: 'Invitation',
    invitationTitle: 'Join this AI Fleet organization',
    invitationBody: 'Review and accept the invitation to add this organization to your account.',
    acceptInvitation: 'Accept invitation',
    acceptingInvitation: 'Accepting invitation…',
    invalidInvitation: 'This invitation link is missing or invalid.',
    invitationAccepted: 'Invitation accepted. Refreshing your workspace…',
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
    workflows: 'Workflows',
    workflowsSub: 'Design ADLC agent flows',
    organization: 'Organization',
    settingsPolicy: 'Settings Policy',
    settingsPolicySub: 'Harness, tools, skills, plugins',
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
    cost: 'Cost',
    costSub: 'Usage & billing',
    system: 'System',
    troubleshooting: 'Troubleshooting',
    troubleshootingSub: 'Diagnose connections',
    settings: 'Settings',
    settingsSub: 'Models and connections',
    workspaceReady: 'Workspace ready',
    localTools: 'BYoM and connected tools',
    checking: 'Checking…',
    setupNeeded: 'Setup needed',
    needsAttention: 'Needs attention',
    connected: 'Connected',
    translationUnavailable: 'Local translation is temporarily unavailable',
    actingAs: 'Acting as {name}',
    security: 'Security',
    authentication: 'Authentication',
    signIn: 'Sign in with Google',
    signInWithMicrosoft: 'Sign in with Microsoft',
    signOut: 'Sign out',
    signedInUser: 'Signed-in user',
    googleAccount: 'Google account',
    protectedWorkspace: 'Protected workspace',
    authLoadingTitle: 'Checking your session',
    authLoading: 'Restoring secure session…',
    authTitle: 'Sign in to AI Fleet',
    authDescription: 'Use your organization account to access this workspace.',
    continueWithGoogle: 'Continue with Google',
    continueWithMicrosoft: 'Continue with Microsoft',
    whySignIn: 'Why do I need to sign in?',
    authDetails: 'You sign in with Google or Microsoft through Firebase; the gateway verifies your Firebase ID token before any workspace request reaches AI Fleet.',
    authenticationFailed: 'We could not verify your session. Try signing in again.',
    sessionExpired: 'Your session expired. Sign in again to continue.',
    details: 'Details',
    retry: 'Retry',
  },
  gu: {
    language: 'ભાષા',
    accountAndContext: 'એકાઉન્ટ અને સંદર્ભ',
    aiFleetProject: 'AI Fleet પ્રોજેક્ટ',
    noOrganization: 'કોઈ સંસ્થા ઉપલબ્ધ નથી',
    noAiFleetProject: 'કોઈ AI Fleet પ્રોજેક્ટ ઉપલબ્ધ નથી',
    contextUnavailable: 'સંસ્થાનો સંદર્ભ હાલમાં ઉપલબ્ધ નથી.',
    regionalLanguages: 'પ્રાદેશિક',
    nationalLanguages: 'રાષ્ટ્રીય',
    internationalLanguages: 'આંતરરાષ્ટ્રીય',
    otherLanguages: 'અન્ય',
    recommended: 'ભલામણ કરેલ',
    invitation: 'આમંત્રણ',
    invitationTitle: 'આ AI Fleet સંસ્થામાં જોડાઓ',
    invitationBody: 'આ સંસ્થાને તમારા ખાતામાં ઉમેરવા માટે આમંત્રણ તપાસો અને સ્વીકારો.',
    acceptInvitation: 'આમંત્રણ સ્વીકારો',
    acceptingInvitation: 'આમંત્રણ સ્વીકારી રહ્યું છે…',
    invalidInvitation: 'આ આમંત્રણ લિંક ખૂટે છે અથવા અમાન્ય છે.',
    invitationAccepted: 'આમંત્રણ સ્વીકારાયું. તમારું કાર્યસ્થળ રિફ્રેશ થઈ રહ્યું છે…',
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
    workflows: 'વર્કફ્લોઝ',
    workflowsSub: 'ADLC એજન્ટ ફ્લો ડિઝાઇન કરો',
    organization: 'સંસ્થા',
    settingsPolicy: 'સેટિંગ્સ નીતિ',
    settingsPolicySub: 'હાર્નેસ, ટૂલ્સ, સ્કિલ્સ, પ્લગઇન્સ',
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
    system: 'સિસ્ટમ',
    troubleshooting: 'સમસ્યા નિવારણ',
    troubleshootingSub: 'જોડાણોનું નિદાન',
    settings: 'સેટિંગ્સ',
    settingsSub: 'મોડેલો અને જોડાણો',
    workspaceReady: 'કાર્યસ્થળ તૈયાર છે',
    localTools: 'BYoM અને જોડાયેલા સાધનો',
    checking: 'તપાસી રહ્યું છે…',
    setupNeeded: 'સેટઅપ જરૂરી છે',
    needsAttention: 'ધ્યાન આપવું જરૂરી છે',
    connected: 'જોડાયેલ છે',
    translationUnavailable: 'સ્થાનિક અનુવાદ હાલમાં ઉપલબ્ધ નથી',
    actingAs: '{name} તરીકે કાર્યરત',
    security: 'સુરક્ષા',
    authentication: 'પ્રમાણીકરણ',
    signIn: 'Google વડે સાઇન ઇન',
    signInWithMicrosoft: 'Microsoft વડે સાઇન ઇન',
    signOut: 'સાઇન આઉટ',
    signedInUser: 'સાઇન ઇન કરેલ વપરાશકર્તા',
    googleAccount: 'Google ખાતું',
    protectedWorkspace: 'સુરક્ષિત કાર્યસ્થળ',
    authLoadingTitle: 'તમારા સત્રની તપાસ થઈ રહી છે',
    authLoading: 'સુરક્ષિત સત્ર પુનઃસ્થાપિત થઈ રહ્યું છે…',
    authTitle: 'AI Fleet માં સાઇન ઇન કરો',
    authDescription: 'આ કાર્યસ્થળ ઍક્સેસ કરવા માટે તમારા સંસ્થાના ખાતાનો ઉપયોગ કરો.',
    continueWithGoogle: 'Google વડે આગળ વધો',
    continueWithMicrosoft: 'Microsoft વડે આગળ વધો',
    whySignIn: 'મારે સાઇન ઇન શા માટે કરવું જરૂરી છે?',
    authDetails: 'તમે Firebase દ્વારા Google અથવા Microsoft થી સાઇન ઇન કરો છો; કાર્યસ્થળની કોઈપણ વિનંતી AI Fleet સુધી પહોંચે તે પહેલાં ગેટવે તમારા Firebase ID ટોકનની ચકાસણી કરે છે.',
    authenticationFailed: 'અમે તમારા સત્રની ચકાસણી કરી શક્યા નથી. ફરી સાઇન ઇન કરવાનો પ્રયાસ કરો.',
    sessionExpired: 'તમારા સત્રની મુદત પૂરી થઈ ગઈ છે. આગળ વધવા માટે ફરી સાઇન ઇન કરો.',
    details: 'વિગતો',
    retry: 'ફરી પ્રયાસ કરો',
  },
  hi: {
    language: 'भाषा',
    accountAndContext: 'खाता और संदर्भ',
    aiFleetProject: 'AI Fleet प्रोजेक्ट',
    noOrganization: 'कोई संगठन उपलब्ध नहीं है',
    noAiFleetProject: 'कोई AI Fleet प्रोजेक्ट उपलब्ध नहीं है',
    contextUnavailable: 'संगठन संदर्भ अभी उपलब्ध नहीं है।',
    regionalLanguages: 'क्षेत्रीय',
    nationalLanguages: 'राष्ट्रीय',
    internationalLanguages: 'अंतरराष्ट्रीय',
    otherLanguages: 'अन्य',
    recommended: 'सुझाया गया',
    invitation: 'निमंत्रण',
    invitationTitle: 'इस AI Fleet संगठन से जुड़ें',
    invitationBody: 'इस संगठन को अपने खाते में जोड़ने के लिए निमंत्रण की समीक्षा करके उसे स्वीकार करें।',
    acceptInvitation: 'निमंत्रण स्वीकार करें',
    acceptingInvitation: 'निमंत्रण स्वीकार किया जा रहा है…',
    invalidInvitation: 'यह निमंत्रण लिंक मौजूद नहीं है या अमान्य है।',
    invitationAccepted: 'निमंत्रण स्वीकार हो गया। आपका कार्यक्षेत्र रीफ़्रेश हो रहा है…',
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
    workflows: 'वर्कफ़्लो',
    workflowsSub: 'ADLC एजेंट फ़्लो डिज़ाइन करें',
    organization: 'संगठन',
    settingsPolicy: 'सेटिंग्स नीति',
    settingsPolicySub: 'हार्नेस, टूल्स, स्किल्स, प्लगइन्स',
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
    system: 'सिस्टम',
    troubleshooting: 'समस्या निवारण',
    troubleshootingSub: 'कनेक्शन का निदान',
    settings: 'सेटिंग्स',
    settingsSub: 'मॉडल और कनेक्शन',
    workspaceReady: 'कार्यक्षेत्र तैयार है',
    localTools: 'BYoM और जुड़े उपकरण',
    checking: 'जाँच हो रही है…',
    setupNeeded: 'सेटअप आवश्यक है',
    needsAttention: 'ध्यान देने की आवश्यकता है',
    connected: 'कनेक्टेड',
    translationUnavailable: 'स्थानीय अनुवाद अभी उपलब्ध नहीं है',
    actingAs: '{name} के रूप में कार्यरत',
    security: 'सुरक्षा',
    authentication: 'प्रमाणीकरण',
    signIn: 'Google से साइन इन',
    signInWithMicrosoft: 'Microsoft से साइन इन',
    signOut: 'साइन आउट',
    signedInUser: 'साइन-इन किया हुआ उपयोगकर्ता',
    googleAccount: 'Google खाता',
    protectedWorkspace: 'सुरक्षित कार्यक्षेत्र',
    authLoadingTitle: 'आपके सत्र की जाँच हो रही है',
    authLoading: 'सुरक्षित सत्र बहाल किया जा रहा है…',
    authTitle: 'AI Fleet में साइन इन करें',
    authDescription: 'इस कार्यक्षेत्र तक पहुँचने के लिए अपने संगठन के खाते का उपयोग करें।',
    continueWithGoogle: 'Google के साथ जारी रखें',
    continueWithMicrosoft: 'Microsoft के साथ जारी रखें',
    whySignIn: 'मुझे साइन इन करने की आवश्यकता क्यों है?',
    authDetails: 'आप Firebase के ज़रिए Google या Microsoft से साइन इन करते हैं; किसी कार्यक्षेत्र अनुरोध के AI Fleet तक पहुँचने से पहले गेटवे आपके Firebase ID टोकन की जाँच करता है।',
    authenticationFailed: 'हम आपके सत्र की जाँच नहीं कर सके। फिर से साइन इन करने का प्रयास करें।',
    sessionExpired: 'आपके सत्र की अवधि समाप्त हो गई है। जारी रखने के लिए फिर से साइन इन करें।',
    details: 'विवरण',
    retry: 'पुनः प्रयास करें',
  },
  mr: {
    language: 'भाषा',
    accountAndContext: 'खाते आणि संदर्भ',
    aiFleetProject: 'AI Fleet प्रकल्प',
    noOrganization: 'कोणतीही संस्था उपलब्ध नाही',
    noAiFleetProject: 'कोणताही AI Fleet प्रकल्प उपलब्ध नाही',
    contextUnavailable: 'संस्थेचा संदर्भ सध्या उपलब्ध नाही.',
    regionalLanguages: 'प्रादेशिक',
    nationalLanguages: 'राष्ट्रीय',
    internationalLanguages: 'आंतरराष्ट्रीय',
    otherLanguages: 'इतर',
    recommended: 'शिफारस केलेले',
    invitation: 'आमंत्रण',
    invitationTitle: 'या AI Fleet संस्थेत सामील व्हा',
    invitationBody: 'ही संस्था तुमच्या खात्यात जोडण्यासाठी आमंत्रण तपासा आणि स्वीकारा.',
    acceptInvitation: 'आमंत्रण स्वीकारा',
    acceptingInvitation: 'आमंत्रण स्वीकारत आहोत…',
    invalidInvitation: 'ही आमंत्रण लिंक उपलब्ध नाही किंवा अवैध आहे.',
    invitationAccepted: 'आमंत्रण स्वीकारले. तुमचे कार्यक्षेत्र रीफ्रेश करत आहोत…',
    skipWorkspace: 'कार्यक्षेत्रावर जा',
    openNavigation: 'नेव्हिगेशन उघडा',
    closeNavigation: 'नेव्हिगेशन बंद करा',
    collapseNavigation: 'नेव्हिगेशन आकुंचित करा',
    expandNavigation: 'नेव्हिगेशन विस्तृत करा',
    primaryNavigation: 'मुख्य नेव्हिगेशन',
    application: 'अनुप्रयोग',
    workspace: 'कार्यक्षेत्र',
    agentOperations: 'एजंट कार्ये',
    workspaceSection: 'कार्यक्षेत्र',
    agentWorkspace: 'एजंट कार्यक्षेत्र',
    workflows: 'वर्कफ्लो',
    workflowsSub: 'ADLC एजंट फ्लो डिझाइन करा',
    organization: 'संस्था',
    settingsPolicy: 'सेटिंग्ज धोरण',
    settingsPolicySub: 'हार्नेस, साधने, कौशल्ये, प्लगइन',
    agentWorkspaceSub: 'कामाचे नियोजन करा आणि चालवा',
    agentJobs: 'एजंट जॉब्स',
    agentJobsSub: 'नियोजन आणि कोडिंगचा इतिहास',
    agentJobsDelete: 'हटवा',
    agentJobsConfirmDelete: 'हटवण्याची पुष्टी करा',
    agentJobsClearFinished: 'पूर्ण झालेल्या जॉब्स साफ करा',
    agentJobsConfirmClear: 'साफ करण्याची पुष्टी करा',
    agentPaused: 'थांबलेले',
    agentPlanningPaused: 'नियोजन थांबले आहे',
    agentJobActivity: 'क्रियाकलाप पहा',
    agentPauseGitTitle: 'स्वयंचलित काम कोड कनेक्शनची प्रतीक्षा करत आहे.',
    agentPauseGitBody: 'GitHub किंवा GitLab जोडले जाऊन तयार होईपर्यंत नवीन काम सुरू होणार नाही. रांगेतील काम सुरक्षित आहे.',
    agentPauseGitAction: 'कोड कनेक्शन तपासा',
    agentPauseGitJob: 'कोड कनेक्शन उपलब्ध नसल्यामुळे ही जॉब थांबली.',
    agentPauseModelTitle: 'स्वयंचलित काम AI मॉडेलची प्रतीक्षा करत आहे.',
    agentPauseModelBody: 'निवडलेले मॉडेल उपलब्ध होईपर्यंत नवीन काम सुरू होणार नाही. रांगेतील काम सुरक्षित आहे.',
    agentPauseModelAction: 'मॉडेल सेटअप तपासा',
    agentPauseModelJob: 'निवडलेले मॉडेल उपलब्ध नसल्यामुळे ही जॉब थांबली.',
    agentPauseTitle: 'स्वयंचलित काम सध्या थांबले आहे.',
    agentPauseBody: 'कार्यक्षेत्र तयार होईपर्यंत नवीन काम सुरू होणार नाही. रांगेतील काम सुरक्षित आहे.',
    agentPauseAction: 'कार्यक्षेत्राचा सेटअप तपासा',
    agentPauseJob: 'कार्यक्षेत्र उपलब्ध नसल्यामुळे ही जॉब थांबली.',
    callRecorder: 'कॉल रेकॉर्डर',
    callRecorderSub: 'एजंट सत्रे रेकॉर्ड करा',
    planning: 'नियोजन',
    business: 'व्यवसाय',
    businessSub: 'संदर्भ आणि भूमिका',
    projects: 'प्रकल्प',
    projectsSub: 'योजना आणि टप्पे',
    board: 'बोर्ड',
    boardSub: 'प्रगतीतील मुद्दे',
    insights: 'अंतर्दृष्टी',
    analytics: 'विश्लेषण',
    analyticsSub: 'खर्च आणि कार्यक्षमता',
    cost: 'खर्च',
    costSub: 'वापर आणि बिलिंग',
    system: 'प्रणाली',
    troubleshooting: 'समस्या निवारण',
    troubleshootingSub: 'कनेक्शनचे निदान करा',
    settings: 'सेटिंग्ज',
    settingsSub: 'मॉडेल आणि कनेक्शन',
    workspaceReady: 'कार्यक्षेत्र तयार आहे',
    localTools: 'BYoM आणि जोडलेली साधने',
    checking: 'तपासत आहे…',
    setupNeeded: 'सेटअप आवश्यक आहे',
    needsAttention: 'लक्ष देणे आवश्यक आहे',
    connected: 'जोडलेले',
    translationUnavailable: 'स्थानिक भाषांतर तात्पुरते उपलब्ध नाही',
    actingAs: '{name} म्हणून कार्यरत',
    security: 'सुरक्षा',
    authentication: 'प्रमाणीकरण',
    signIn: 'Google ने साइन इन करा',
    signInWithMicrosoft: 'Microsoft ने साइन इन करा',
    signOut: 'साइन आउट',
    signedInUser: 'साइन इन केलेला वापरकर्ता',
    googleAccount: 'Google खाते',
    protectedWorkspace: 'संरक्षित कार्यक्षेत्र',
    authLoadingTitle: 'तुमचे सत्र तपासत आहोत',
    authLoading: 'सुरक्षित सत्र पुनर्संचयित करत आहोत…',
    authTitle: 'AI Fleet मध्ये साइन इन करा',
    authDescription: 'या कार्यक्षेत्रात प्रवेश करण्यासाठी तुमच्या संस्थेचे खाते वापरा.',
    continueWithGoogle: 'Google सह पुढे जा',
    continueWithMicrosoft: 'Microsoft सह पुढे जा',
    whySignIn: 'मला साइन इन का करावे लागते?',
    authDetails: 'तुम्ही Firebase द्वारे Google किंवा Microsoft वापरून साइन इन करता; कार्यक्षेत्राची कोणतीही विनंती AI Fleet पर्यंत पोहोचण्यापूर्वी गेटवे तुमचे Firebase ID टोकन तपासतो.',
    authenticationFailed: 'आम्ही तुमचे सत्र सत्यापित करू शकलो नाही. पुन्हा साइन इन करून पाहा.',
    sessionExpired: 'तुमच्या सत्राची मुदत संपली आहे. पुढे जाण्यासाठी पुन्हा साइन इन करा.',
    details: 'तपशील',
    retry: 'पुन्हा प्रयत्न करा',
  },
});

let locale = normalizeLocale(readSavedLocale()) || DEFAULT_LOCALE;
let recommendedLocale = '';
let observer = null;
let translationTimer = null;
let translationGeneration = 0;
let localizationPasses = 0;
let fallbackRetryTimer = null;
let fallbackRetryAttempts = 0;
let translationDegraded = false;
let suggestionRefreshPromise = null;
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

export function hasSavedLocale() {
  return Boolean(normalizeLocale(readSavedLocale()));
}

export function normalizeLocale(value) {
  try {
    const [canonical] = Intl.getCanonicalLocales(String(value || '').trim());
    if (!canonical) return '';
    const language = new Intl.Locale(canonical).language;
    return ({ en: 'en', gu: 'gu-IN', mr: 'mr-IN', hi: 'hi-IN', es: 'es', fr: 'fr', de: 'de', pt: 'pt-BR', ja: 'ja-JP', ar: 'ar' })[language] || '';
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

export function renderLanguageControl() {
  const host = document.getElementById('language-control');
  if (!host) return;
  host.dataset.i18nSkip = 'true';
  const select = document.createElement('select');
  select.id = 'language-select';
  select.className = 'language-select';
  select.setAttribute('aria-label', t('language'));

  for (const group of LANGUAGE_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = t(group.key);
    const items = [...group.items].sort((a, b) => (
      Number(b.tag === recommendedLocale) - Number(a.tag === recommendedLocale)
    ));
    for (const item of items) {
      const option = document.createElement('option');
      const recommended = item.tag === recommendedLocale;
      option.value = item.tag;
      option.textContent = `${item.nativeLabel}${recommended ? ` — ${t('recommended')}` : ''}`;
      option.title = `${item.label}${recommended ? ` — ${t('recommended')}` : ''}`;
      option.selected = item.tag === locale;
      if (recommended) option.dataset.recommended = 'true';
      optgroup.append(option);
    }
    select.append(optgroup);
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
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {
      // The in-memory selection remains active when browser storage is blocked.
    }
  }
  if (next === locale && document.documentElement.lang === next) return;
  locale = next;
  markTranslationHealthy();
  applyDocumentLocale();
  renderLanguageControl();
  localize(document);
  window.dispatchEvent(new CustomEvent('ai-fleet:locale-changed', { detail: { locale } }));
}

async function loadRecommendation(options = {}) {
  if (hasSavedLocale()) {
    recommendedLocale = '';
    return;
  }
  try {
    const response = await api.getLocaleSuggestions(
      navigator.languages || [navigator.language],
      options
    );
    recommendedLocale = normalizeLocale(response.recommendedLocale) || '';
  } catch (_) {
    recommendedLocale = '';
  }
}

/**
 * Refresh locale suggestions without making them part of the first-render
 * critical path. It is safe to fire-and-forget this after initializeI18n():
 * concurrent callers share one request, and the language control/document are
 * synchronized when the best-effort response arrives.
 */
export function refreshLocaleSuggestions(options = {}) {
  if (hasSavedLocale()) {
    recommendedLocale = '';
    renderLanguageControl();
    return Promise.resolve({ locale, recommendedLocale, suggestions: [...ALL_LOCALES] });
  }
  if (suggestionRefreshPromise) return suggestionRefreshPromise;
  suggestionRefreshPromise = (async () => {
    await loadRecommendation(options);
    applyDocumentLocale();
    renderLanguageControl();
    localize(document);
    return { locale, recommendedLocale, suggestions: [...ALL_LOCALES] };
  })().finally(() => {
    suggestionRefreshPromise = null;
  });
  return suggestionRefreshPromise;
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
  if (discover) await loadRecommendation();
  applyDocumentLocale();
  renderLanguageControl();
  localize(document);
  watchDynamicContent();
  return { locale, recommendedLocale, suggestions: [...ALL_LOCALES] };
}
