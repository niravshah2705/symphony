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
    softwareFactoryProject: 'Software Factory project',
    noOrganization: 'No organization available',
    noSoftwareFactoryProject: 'No Software Factory project available',
    contextUnavailable: 'Organization context is temporarily unavailable.',
    regionalLanguages: 'Regional',
    nationalLanguages: 'National',
    internationalLanguages: 'International',
    otherLanguages: 'Others',
    recommended: 'Recommended',
    invitation: 'Invitation',
    invitationTitle: 'Join this Software Factory organization',
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
    contextAppliesTo: 'New work is filed under',
    switchingTo: 'Switching to',
    contextNoOrganization: 'no organization',
    guestBannerTitle: "You're browsing as a guest",
    guestBannerBody: 'This workspace is read-only and nothing is saved: the Agent answers without an organization behind it. Sign in to run work in your own organizations and projects.',
    guestBannerDismiss: 'Dismiss',
    guestOnboardingEyebrow: 'Guest demo',
    guestOnboardingTitle: 'How this demo works',
    guestOnboardingBody: 'You are browsing as a guest, so the assistant takes clicks instead of typing. Pick an option, and it walks you through what a real run would do.',
    guestOnboardingStep1: 'Choose a starter option below the chat. There is nothing to type.',
    guestOnboardingStep2: 'Answer the questions with the buttons it offers — each answer picks one variation.',
    guestOnboardingStep3: 'Watch the run: the plan, the agent it would deploy, and a preview site built from that plan.',
    guestOnboardingStep4: 'The preview and this conversation last one day. Sign in to keep your work and run it for real.',
    guestOnboardingReviewed: 'I have reviewed this',
    guestOnboardingSkip: 'Skip for now',
    guestOnboardingClose: 'Close',
    guestHeroEyebrow: 'Guest demo · no account needed',
    guestHeroTitle: 'See what a run does — by clicking, not typing.',
    guestHeroBody: 'Pick a starter option below and the demo plans it, shows the agent set it would deploy, and releases a preview site. Every answer is a button: there is nothing to type.',
    guestRailHeading: 'Guest demo',
    guestRailBadge: 'No account',
    guestRailCopy: 'Each click runs a scripted demo against first-party samples. Sign in for your own history and workspace activity.',
    guestThreadsLabel: 'Guest demo access',
    guestToolbarChip: 'Scripted demos only',
    guestRailTitle: 'Read-only, and on purpose',
    guestRailBody: 'The guest demo is isolated from organizations, projects, conversations and run activity — those need an account.',
    guestRestrictedCardTitle: 'What a guest can and cannot do',
    guestIntroTitle: 'Nothing to type — pick an option.',
    guestIntroBody: 'The starter buttons below run a scripted demo: a plan, the agent configuration it would deploy, and a preview site that lives for a day. Tenant data and real agent runs stay closed until you sign in.',
    guestRestrictedNotice: 'Restricted access: you are browsing as a guest. Pick from the options below — free text, tenant data and agent runs need an account.',
    guestDataNotRetrievable: 'Guest conversations are not tied to an account and cannot be retrieved later. Sign in to keep your history.',
    guestPreviewExpiryNotice: 'Each demo session and the site it generates stay available for {days} day, then are deleted.',
    guestSignInCta: 'Sign in for the full experience',
    guestComposerHint: 'Pick one of these — a guest demo has no text box, because there is nothing a guest is asked to describe.',
    guestStarterGroup: 'Guest demo starter options',
    guestStarterLoading: 'Loading the demo options…',
    guestStarterUnavailable: 'The demo options are unavailable right now.',
    guestStarterRetry: 'Try again',
    guestCommandEcho: 'Got it — here is what I can set up.',
    guestCmdHelloWorld: 'Create my hello-world application',
    guestCmdTicTacToe: 'Create my tic-tac-toe application',
    guestCmdReverseEngineer: 'Reverse engineer a website',
    guestCmdDocsSearch: 'Search the reviewed documentation',
    guestQHelloWorldStack: 'Which stack should the hello-world app use?',
    guestAHelloWorldNode: 'Node.js',
    guestAHelloWorldStatic: 'Static HTML',
    guestQHelloWorldTheme: 'Pick a starting look.',
    guestAThemeIndigo: 'Indigo',
    guestAThemeEmerald: 'Emerald',
    guestQTicTacToeTheme: 'Which board theme?',
    guestAThemeClassic: 'Classic light',
    guestAThemeDark: 'Dark',
    guestQTicTacToeMode: 'Who plays against whom?',
    guestATicTacToeLocal: 'Two players on one device',
    guestATicTacToeAi: 'Play against the computer',
    guestQReverseTarget: 'Which example site should we take apart?',
    guestAReverseStorefront: 'Sample storefront',
    guestAReverseSaas: 'Sample SaaS landing page',
    guestAReverseDocs: 'Sample documentation site',
    guestQReverseDepth: 'How far should the rebuild go?',
    guestAReverseMap: 'Component map and clone plan only',
    guestAReverseFull: 'Rebuild the page as a webapp',
    guestQDocsTopic: 'What should I look up in the reviewed documentation?',
    guestADocsAdlc: 'What is the Agentic Development Life Cycle?',
    guestADocsPlanner: 'How does the planner break work down?',
    guestADocsEgress: 'How are credentials kept out of agents?',
    guestQDocsResult: 'Want to see what else a demo session can do?',
    guestADocsBuildNext: 'Yes — build me an application',
    guestADocsStop: 'No, that was enough',
    guestQCustomiseAccent: 'Your site is live. Change the accent colour?',
    guestAAccentEmerald: 'Emerald',
    guestAAccentAmber: 'Amber',
    guestAAccentKeep: 'Keep it as it is',
    guestQCustomiseFeature: 'Add one more thing before you go?',
    guestAFeaturePage: 'A second page',
    guestAFeatureFooter: 'A footer with contact details',
    guestAFeatureNone: 'Nothing else',
    guestQCustomiseDone: 'Anything else?',
    guestADoneRestart: 'Start another demo session',
    guestADoneStop: 'No, I am done',
    guestDemoReplyTitle: 'Guest demo',
    guestDemoPreviewTitle: 'Your preview is still live',
    guestDemoOpenPreview: 'Open the preview',
    guestDemoEnd: 'That is the end of this demo.',
    guestDemoEndBody: 'Sign in to run this for real, or pick another option below — each click opens a fresh session.',
    guestDemoRestartTitle: 'Start another demo',
    guestDemoRestartBody: 'This session is closed. Pick any option below — each click opens a fresh one.',
    guestDemoStopped: 'This demo session has reached its limit.',
    guestMessageCap: 'This demo session holds {messages} messages. Sign in to keep going.',
    guestDemoFlowTitle: 'Here is what this run produced',
    guestDemoSimulatedNotice: 'Simulated preview — nothing was applied to a cluster.',
    guestDemoArtifactSummary: 'The agent configuration this run would apply',
    guestDemoPreviewSkipped: 'Preview publishing is not enabled on this deployment, so this step was skipped.',
    guestDemoStepPlan: 'Plan the build',
    guestDemoStepSkill: 'Mount the demo skill',
    guestDemoStepCrset: 'Render the kagent agent',
    guestDemoStepDeploy: 'Deploy as a webapp',
    guestDemoStepLiveUrl: 'Preview URL is live for {days} day',
    guestFollowupHint: 'Pick one — the answers are fixed, so there is nothing to type.',
    guestFollowupGroup: 'Choose one',
    guestDocsSearching: 'Searching the reviewed documentation…',
    guestDocsResultTitle: 'What the documentation says',
    guestDocsResultBody: 'From {count} indexed documents — the full answer, with workspace memory, is available once you sign in.',
    guestDocsNoResults: 'Nothing in the reviewed documentation matched that. Sign in and ask in your own workspace.',
    guestSessionExpired: 'That demo session expired. Pick an option to start a new one.',
    guestStepStale: 'That step has already been answered. Pick an option to start a new one.',
    guestDemoSignedIn: 'You are signed in, so the guest demo is not needed here.',
    guestDemoRateLimited: 'That was quick — the guest demo is limited per address. Wait a moment and try again.',
    guestDemoFailed: 'The guest demo could not continue.',
    actors: 'Actor runs',
    actorsSub: 'Running, paused and stalled actors',
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
    authTitle: 'Sign in to Software Factory',
    authDescription: 'Use your organization account to access this workspace.',
    continueWithGoogle: 'Continue with Google',
    continueWithMicrosoft: 'Continue with Microsoft',
    whySignIn: 'Why do I need to sign in?',
    authDetails: 'You sign in with Google or Microsoft through Firebase; the gateway verifies your Firebase ID token before any workspace request reaches Software Factory.',
    authenticationFailed: 'We could not verify your session. Try signing in again.',
    sessionExpired: 'Your session expired. Sign in again to continue.',
    details: 'Details',
    retry: 'Retry',
  },
  gu: {
    language: 'ભાષા',
    accountAndContext: 'એકાઉન્ટ અને સંદર્ભ',
    softwareFactoryProject: 'Software Factory પ્રોજેક્ટ',
    noOrganization: 'કોઈ સંસ્થા ઉપલબ્ધ નથી',
    noSoftwareFactoryProject: 'કોઈ Software Factory પ્રોજેક્ટ ઉપલબ્ધ નથી',
    contextUnavailable: 'સંસ્થાનો સંદર્ભ હાલમાં ઉપલબ્ધ નથી.',
    regionalLanguages: 'પ્રાદેશિક',
    nationalLanguages: 'રાષ્ટ્રીય',
    internationalLanguages: 'આંતરરાષ્ટ્રીય',
    otherLanguages: 'અન્ય',
    recommended: 'ભલામણ કરેલ',
    invitation: 'આમંત્રણ',
    invitationTitle: 'આ Software Factory સંસ્થામાં જોડાઓ',
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
    contextAppliesTo: 'નવી કામગીરી નોંધાય છે',
    switchingTo: 'બદલવામાં',
    contextNoOrganization: 'કોઈ સંસ્થા નથી',
    guestBannerTitle: 'તમે અતિથિ તરીકે ફરી રહ્યા છો',
    guestBannerBody: 'આ વર્કસ્પેસ ફક્ત-વાંચન છે અને કંઈ સાચવાતું નથી: એજન્ટ કોઈ સંસ્થા વિના જવાબ આપે છે. તમારી પોતાની સંસ્થાઓ અને પ્રોજેક્ટ્સમાં કામ ચલાવવા માટે સાઇન ઇન કરો.',
    guestBannerDismiss: 'બંધ કરો',
    guestOnboardingEyebrow: 'ગેસ્ટ ડેમો',
    guestOnboardingTitle: 'આ ડેમો કેવી રીતે કામ કરે છે',
    guestOnboardingBody: 'તમે ગેસ્ટ તરીકે ફરી રહ્યા છો, તેથી એસિસ્ટન્ટ ટાઇપ કરવાને બદલે ક્લિક સ્વીકારે છે. એક વિકલ્પ પસંદ કરો, અને તે તમને બતાવશે કે સાચું રન શું કરે.',
    guestOnboardingStep1: 'ચેટની નીચે સ્ટાર્ટર વિકલ્પ પસંદ કરો. ટાઇપ કરવાનું કંઈ નથી.',
    guestOnboardingStep2: 'આપેલા બટનથી પ્રશ્નોના જવાબ આપો — દરેક જવાબ એક વેરિએશન પસંદ કરે છે.',
    guestOnboardingStep3: 'રન જુઓ: યોજના, જે એજન્ટ તૈયાર કરાશે, અને તે યોજના પરથી બનેલી પ્રીવ્યુ સાઇટ.',
    guestOnboardingStep4: 'પ્રીવ્યુ અને આ વાત એક દિવસ સુધી રહેશે. તમારું કામ સાચવવા અને સાચે ચલાવવા સાઇન ઇન કરો.',
    guestOnboardingReviewed: 'મેં આ જોઈ લીધું છે',
    guestOnboardingSkip: 'હાલમાં છોડો',
    guestOnboardingClose: 'બંધ કરો',
    guestHeroEyebrow: 'ગેસ્ટ ડેમો · કોઈ ખાતું નહીં',
    guestHeroTitle: 'રન શું કરે છે તે જુઓ — ટાઇપ કર્યા વગર, ક્લિક કરીને.',
    guestHeroBody: 'નીચે સ્ટાર્ટર વિકલ્પ પસંદ કરો; ડેમો તેની યોજના બનાવે, જે એજન્ટ સેટ તૈયાર કરાય તે બતાવે, અને પ્રીવ્યુ સાઇટ પ્રકાશિત કરે. દરેક જવાબ બટન છે: ટાઇપ કરવાનું કંઈ નથી.',
    guestRailHeading: 'ગેસ્ટ ડેમો',
    guestRailBadge: 'કોઈ ખાતું નહીં',
    guestRailCopy: 'દરેક ક્લિક અમારી પોતાની નમૂના સાઇટ પર સ્ક્રિપ્ટેડ ડેમો ચલાવે છે. તમારો ઇતિહાસ અને વર્કસ્પેસ ગતિવિધિ જોવા સાઇન ઇન કરો.',
    guestThreadsLabel: 'ગેસ્ટ ડેમો ઍક્સેસ',
    guestToolbarChip: 'ફક્ત સ્ક્રિપ્ટેડ ડેમો',
    guestRailTitle: 'ફક્ત-વાંચન, અને જાણીને',
    guestRailBody: 'ગેસ્ટ ડેમો સંસ્થાઓ, પ્રોજેક્ટ્સ, વાતો અને રન ગતિવિધિથી અલગ છે — તેના માટે ખાતું જોઈએ.',
    guestRestrictedCardTitle: 'ગેસ્ટ શું કરી શકે અને શું નહીં',
    guestIntroTitle: 'ટાઇપ કરવાનું કંઈ નથી — એક વિકલ્પ પસંદ કરો.',
    guestIntroBody: 'નીચેની સ્ટાર્ટર બટન સ્ક્રિપ્ટેડ ડેમો ચલાવે: યોજના, જે એજન્ટ રૂપરેખા તૈયાર કરાય, અને એક દિવસ રહે પ્રીવ્યુ સાઇટ. સાઇન ઇન સુધી ટેનન્ટ ડેટા અને સાચા એજન્ટ રન બંધ રહે.',
    guestRestrictedNotice: 'મર્યાદિત ઍક્સેસ: તમે ગેસ્ટ તરીકે ફરી રહ્યા છો. નીચે વિકલ્પ પસંદ કરો — મુક્ત ટેક્સ્ટ, ટેનન્ટ ડેટા અને એજન્ટ રન માટે ખાતું જોઈએ.',
    guestDataNotRetrievable: 'ગેસ્ટ વાતો ખાતા સાથે જોડાયેલી નથી અને પછીથી મળી શકતી નથી. તમારો ઇતિહાસ સાચવવા સાઇન ઇન કરો.',
    guestPreviewExpiryNotice: 'દરેક ડેમો સત્ર અને તેણે બનાવેલી સાઇટ {days} દિવસ સુધી રહે છે, પછી કાઢી નાખવામાં આવે છે.',
    guestSignInCta: 'પૂર્ણ અનુભવ માટે સાઇન ઇન કરો',
    guestComposerHint: 'આમાંથી એક પસંદ કરો — ગેસ્ટ ડેમોમાં ટેક્સ્ટ બૉક્સ નથી, કારણ કે ગેસ્ટ પાસે વર્ણન માંગવાનું કંઈ નથી.',
    guestStarterGroup: 'ગેસ્ટ ડેમો સ્ટાર્ટર વિકલ્પો',
    guestStarterLoading: 'ડેમો વિકલ્પો લોડ થઈ રહ્યા છે…',
    guestStarterUnavailable: 'ડેમો વિકલ્પો હાલમાં ઉપલબ્ધ નથી.',
    guestStarterRetry: 'ફરી પ્રયાસ કરો',
    guestCommandEcho: 'સમજાઈ ગયું — હું શું સેટ અપ કરી શકું તે અહીં છે.',
    guestCmdHelloWorld: 'મારી hello-world એપ્લિકેશન બનાવો',
    guestCmdTicTacToe: 'મારી ટિક-ટૅક-ટો એપ્લિકેશન બનાવો',
    guestCmdReverseEngineer: 'એક વેબસાઇટનું રિવર્સ એન્જિનિંગ કરો',
    guestCmdDocsSearch: 'સમીક્ષા કરેલા દસ્તાવેજોમાં શોધો',
    guestQHelloWorldStack: 'hello-world ઍપ કયો સ્ટૅક વાપરે?',
    guestAHelloWorldNode: 'Node.js',
    guestAHelloWorldStatic: 'સ્ટૅટિક HTML',
    guestQHelloWorldTheme: 'શરૂઆતનો દેખાવ પસંદ કરો.',
    guestAThemeIndigo: 'ઇન્ડિગો',
    guestAThemeEmerald: 'એમરોલ્ડ',
    guestQTicTacToeTheme: 'કયો બોર્ડ થીમ?',
    guestAThemeClassic: 'ક્લાસિક લાઇટ',
    guestAThemeDark: 'ડાર્ક',
    guestQTicTacToeMode: 'કોણ કોની સામે રમે?',
    guestATicTacToeLocal: 'એક ઉપકરણ પર બે ખેલાડી',
    guestATicTacToeAi: 'કમ્પ્યુટર સામે રમો',
    guestQReverseTarget: 'કયા નમૂના સાઇટનું વિઘટન કરીએ?',
    guestAReverseStorefront: 'નમૂના સ્ટોરફ્રન્ટ',
    guestAReverseSaas: 'નમૂના SaaS લેન્ડિંગ પેજ',
    guestAReverseDocs: 'નમૂના દસ્તાવેજ સાઇટ',
    guestQReverseDepth: 'રીબિલ્ડ કેટલું આગળ જાય?',
    guestAReverseMap: 'ફક્ત ઘટક નકશો અને ક્લોન યોજના',
    guestAReverseFull: 'પેજને વેબૅપ તરીકે ફરી બનાવો',
    guestQDocsTopic: 'સમીક્ષા કરેલા દસ્તાવેજોમાં હું શું શોધું?',
    guestADocsAdlc: 'Agentic Development Life Cycle શું છે?',
    guestADocsPlanner: 'પ્લાનર કામને કેવી રીતે વહેંચે છે?',
    guestADocsEgress: 'એજન્ટથી ક્રેડેન્શિયલ કેવી રીતે દૂર રાખવામાં આવે છે?',
    guestQDocsResult: 'ડેમો સત્ર બીજું શું કરી શકે તે જોવાનું?',
    guestADocsBuildNext: 'હા — મને એક એપ્લિકેશન બનાવી આપો',
    guestADocsStop: 'ના, એ પૂરતું હતું',
    guestQCustomiseAccent: 'તમારી સાઇટ લાઇવ છે. ઍક્સેન્ટ રંગ બદલશો?',
    guestAAccentEmerald: 'એમરોલ્ડ',
    guestAAccentAmber: 'એમ્બર',
    guestAAccentKeep: 'તેમ જ રાખો',
    guestQCustomiseFeature: 'જવા પહેલાં બીજું એક વસ્તું ઉમેરશો?',
    guestAFeaturePage: 'બીજું પાનું',
    guestAFeatureFooter: 'સંપર્ક વિગતો સાથે ફૂટર',
    guestAFeatureNone: 'બીજું કંઈ નહીં',
    guestQCustomiseDone: 'બીજું કંઈ?',
    guestADoneRestart: 'બીજું ડેમો સત્ર શરૂ કરો',
    guestADoneStop: 'ના, હું પૂરો થયો',
    guestDemoReplyTitle: 'ગેસ્ટ ડેમો',
    guestDemoPreviewTitle: 'તમારી પ્રીવ્યુ હજી લાઇવ છે',
    guestDemoOpenPreview: 'પ્રીવ્યુ ખોલો',
    guestDemoEnd: 'આ ડેમોનો અંત.',
    guestDemoEndBody: 'સાચે ચલાવવા સાઇન ઇન કરો, અથવા નીચે બીજો વિકલ્પ પસંદ કરો — દરેક ક્લિક નવું સત્ર ખોલે.',
    guestDemoRestartTitle: 'બીજો ડેમો શરૂ કરો',
    guestDemoRestartBody: 'આ સત્ર બંધ છે. નીચે કોઈ પણ વિકલ્પ પસંદ કરો — દરેક ક્લિક નવું સત્ર ખોલે.',
    guestDemoStopped: 'આ ડેમો સત્ર તેની મર્યાદા પર પહોંચ્યું.',
    guestMessageCap: 'આ ડેમો સત્ર {messages} સંદેશા રાખે છે. આગળ ચાલુ રાખવા સાઇન ઇન કરો.',
    guestDemoFlowTitle: 'આ રનમાં જે બન્યું તે',
    guestDemoSimulatedNotice: 'સિમ્યુલેટેડ પ્રીવ્યુ — ક્લસ્ટર પર કંઈ લાગુ કરવામાં આવ્યું નથી.',
    guestDemoArtifactSummary: 'આ રન જે એજન્ટ રૂપરેખા લાગુ કરે',
    guestDemoPreviewSkipped: 'આ ડિપ્લોયમેન્ટમાં પ્રીવ્યુ પ્રકાશન ચાલુ નથી, તેથી આ પગલું છોડાયું.',
    guestDemoStepPlan: 'બિલ્ડની યોજના બનાવો',
    guestDemoStepSkill: 'ડેમો સ્કિલ માઉન્ટ કરો',
    guestDemoStepCrset: 'kagent એજન્ટ રેન્ડર કરો',
    guestDemoStepDeploy: 'વેબૅપ તરીકે ડિપ્લોય કરો',
    guestDemoStepLiveUrl: 'પ્રીવ્યુ URL {days} દિવસ સુધી લાઇવ',
    guestFollowupHint: 'એક પસંદ કરો — જવાબ નિશ્ચિત છે, તેથી ટાઇપ કરવાનું કંઈ નથી.',
    guestFollowupGroup: 'એક પસંદ કરો',
    guestDocsSearching: 'સમીક્ષા કરેલા દસ્તાવેજોમાં શોધ થઈ રહી છે…',
    guestDocsResultTitle: 'દસ્તાવેજોમાં શું કહે છે',
    guestDocsResultBody: '{count} ઇન્ડેક્સ કરેલા દસ્તાવેજોમાંથી — પૂરો જવાબ, વર્કસ્પેસ મેમરી સાથે, સાઇન ઇન પછી ઉપલબ્ધ.',
    guestDocsNoResults: 'સમીક્ષા કરેલા દસ્તાવેજોમાં તે મેળ ખાતું કંઈ નથી. સાઇન ઇન કરી તમારા વર્કસ્પેસમાં પૂછો.',
    guestSessionExpired: 'આ ડેમો સત્રની મુદત પૂરી. નવું સત્ર શરૂ કરવા વિકલ્પ પસંદ કરો.',
    guestStepStale: 'આ પગલાનો જવાબ પહેલેથી આપાયો છે. નવું સત્ર શરૂ કરવા વિકલ્પ પસંદ કરો.',
    guestDemoSignedIn: 'તમે સાઇન ઇન છો, તેથી અહીં ગેસ્ટ ડેમોની જરૂર નથી.',
    guestDemoRateLimited: 'તે ઝડપી હતું — ગેસ્ટ ડેમો દરેક સરનામા માટે મર્યાદિત છે. થોડી વાર પછી ફરી પ્રયાસ કરો.',
    guestDemoFailed: 'ગેસ્ટ ડેમો આગળ ચાલી શક્યો નહીં.',
    actors: 'એક્ટર રન',
    actorsSub: 'ચાલતા, વિરામમાં અને અટકેલા એક્ટર્સ',
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
    authTitle: 'Software Factory માં સાઇન ઇન કરો',
    authDescription: 'આ કાર્યસ્થળ ઍક્સેસ કરવા માટે તમારા સંસ્થાના ખાતાનો ઉપયોગ કરો.',
    continueWithGoogle: 'Google વડે આગળ વધો',
    continueWithMicrosoft: 'Microsoft વડે આગળ વધો',
    whySignIn: 'મારે સાઇન ઇન શા માટે કરવું જરૂરી છે?',
    authDetails: 'તમે Firebase દ્વારા Google અથવા Microsoft થી સાઇન ઇન કરો છો; કાર્યસ્થળની કોઈપણ વિનંતી Software Factory સુધી પહોંચે તે પહેલાં ગેટવે તમારા Firebase ID ટોકનની ચકાસણી કરે છે.',
    authenticationFailed: 'અમે તમારા સત્રની ચકાસણી કરી શક્યા નથી. ફરી સાઇન ઇન કરવાનો પ્રયાસ કરો.',
    sessionExpired: 'તમારા સત્રની મુદત પૂરી થઈ ગઈ છે. આગળ વધવા માટે ફરી સાઇન ઇન કરો.',
    details: 'વિગતો',
    retry: 'ફરી પ્રયાસ કરો',
  },
  hi: {
    language: 'भाषा',
    accountAndContext: 'खाता और संदर्भ',
    softwareFactoryProject: 'Software Factory प्रोजेक्ट',
    noOrganization: 'कोई संगठन उपलब्ध नहीं है',
    noSoftwareFactoryProject: 'कोई Software Factory प्रोजेक्ट उपलब्ध नहीं है',
    contextUnavailable: 'संगठन संदर्भ अभी उपलब्ध नहीं है।',
    regionalLanguages: 'क्षेत्रीय',
    nationalLanguages: 'राष्ट्रीय',
    internationalLanguages: 'अंतरराष्ट्रीय',
    otherLanguages: 'अन्य',
    recommended: 'सुझाया गया',
    invitation: 'निमंत्रण',
    invitationTitle: 'इस Software Factory संगठन से जुड़ें',
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
    guestBannerTitle: 'आप मेहमान के रूप में देख रहे हैं',
    guestBannerBody: 'यह कार्यक्षेत्र केवल-पढ़ने के लिए है और कुछ भी सहेजा नहीं जाता: एजेंट बिना किसी संगठन के उत्तर देता है। अपने संगठनों और परियोजनाओं में काम चलाने के लिए साइन इन करें।',
    guestBannerDismiss: 'बंद करें',
    guestOnboardingEyebrow: 'गेस्ट डेमो',
    guestOnboardingTitle: 'यह डेमो कैसे काम करता है',
    guestOnboardingBody: 'आप मेहमान के रूप में देख रहे हैं, इसलिए असिस्टेंट टाइप करने के बजाय क्लिक स्वीकार करता है। एक विकल्प चुनें, और यह दिखाएगा कि असली रन क्या करता है।',
    guestOnboardingStep1: 'चैट के नीचे स्टार्टर विकल्प चुनें। टाइप करने की ज़रूरत नहीं।',
    guestOnboardingStep2: 'दिए गए बटन से सवालों के जवाब दें — हर जवाब एक वेरिएशन चुनता है।',
    guestOnboardingStep3: 'रन देखें: योजना, कौन सा एजेंट तैयार होगा, और उसी योजना से बनी प्रीव्यू साइट।',
    guestOnboardingStep4: 'प्रीव्यू और यह बातचीत एक दिन तक रहेगी। अपना काम बचाने और असल में चलाने के लिए साइन इन करें।',
    guestOnboardingReviewed: 'मैंने यह देख लिया है',
    guestOnboardingSkip: 'अभी छोड़ दें',
    guestOnboardingClose: 'बंद करें',
    guestHeroEyebrow: 'गेस्ट डेमो · खाते की ज़रूरत नहीं',
    guestHeroTitle: 'रन क्या करता है देखें — टाइप नहीं, क्लिक करके।',
    guestHeroBody: 'नीचे स्टार्टर विकल्प चुनें; डेमो उसकी योजना बनाता है, कौन सा एजेंट सेट तैयार होगा वह दिखाता है, और एक प्रीव्यू साइट जारी करता है। हर जवाब एक बटन है: टाइप करने को कुछ नहीं।',
    guestRailHeading: 'गेस्ट डेमो',
    guestRailBadge: 'कोई खाता नहीं',
    guestRailCopy: 'हर क्लिक हमारी अपनी सैंपल साइटों पर स्क्रिप्टेड डेमो चलाता है। अपना इतिहास और वर्कस्पेस गतिविधि देखने के लिए साइन इन करें।',
    guestThreadsLabel: 'गेस्ट डेमो पहुँच',
    guestToolbarChip: 'केवल स्क्रिप्टेड डेमो',
    guestRailTitle: 'केवल-पठन, और जान-बूझकर',
    guestRailBody: 'गेस्ट डेमो संगठनों, परियोजनाओं, बातचीत और रन गतिविधि से अलग है — उनके लिए खाता चाहिए।',
    guestRestrictedCardTitle: 'मेहमान क्या कर सकता है और क्या नहीं',
    guestIntroTitle: 'टाइप करने को कुछ नहीं — एक विकल्प चुनें।',
    guestIntroBody: 'नीचे के स्टार्टर बटन स्क्रिप्टेड डेमो चलाते हैं: योजना, कौन सी एजेंट विन्यास तैयार होगी, और एक दिन रहने वाली प्रीव्यू साइट। साइन इन तक टेंट डेटा और असली एजेंट रन बंद रहते हैं।',
    guestRestrictedNotice: 'प्रतिबंधित पहुँच: आप मेहमान के रूप में देख रहे हैं। नीचे से विकल्प चुनें — मुक्त पाठ, टेंट डेटा और एजेंट रन के लिए खाता चाहिए।',
    guestDataNotRetrievable: 'गेस्ट बातचीत खाते से जुड़ी नहीं होती और बाद में नहीं मिल सकती। अपना इतिहास बचाने के लिए साइन इन करें।',
    guestPreviewExpiryNotice: 'हर डेमो सत्र और उससे बनी साइट {days} दिन तक उपलब्ध रहती है, फिर हटा दी जाती है।',
    guestSignInCta: 'पूरा अनुभव पाने के लिए साइन इन करें',
    guestComposerHint: 'इनमें से एक चुनें — गेस्ट डेमो में टेक्स्ट बॉक्स नहीं है, क्योंकि मेहमान से वर्णन माँगा नहीं जाता।',
    guestStarterGroup: 'गेस्ट डेमो स्टार्टर विकल्प',
    guestStarterLoading: 'डेमो विकल्प लोड हो रहे हैं…',
    guestStarterUnavailable: 'डेमो विकल्प अभी उपलब्ध नहीं हैं।',
    guestStarterRetry: 'फिर कोशिश करें',
    guestCommandEcho: 'समझ गया — मैं क्या तैयार कर सकता हूं वह यहाँ है।',
    guestCmdHelloWorld: 'मेरा hello-world एप्लिकेशन बनाएं',
    guestCmdTicTacToe: 'मेरा टिक-टैक-टो एप्लिकेशन बनाएं',
    guestCmdReverseEngineer: 'एक वेबसाइट का रिवर्स इंजीनियरिंग करें',
    guestCmdDocsSearch: 'समीक्षा किए गए दस्तावेज़ों में खोजें',
    guestQHelloWorldStack: 'hello-world एप कौन सा स्टैक इस्तेमाल करे?',
    guestAHelloWorldNode: 'Node.js',
    guestAHelloWorldStatic: 'स्टैटिक HTML',
    guestQHelloWorldTheme: 'शुरुआती रूप चुनें।',
    guestAThemeIndigo: 'इंडिगो',
    guestAThemeEmerald: 'एमरॉल्ड',
    guestQTicTacToeTheme: 'कौन सा बोर्ड थीम?',
    guestAThemeClassic: 'क्लासिक लाइट',
    guestAThemeDark: 'डार्क',
    guestQTicTacToeMode: 'कौन किसके खिलाफ खेले?',
    guestATicTacToeLocal: 'एक डिवाइस पर दो खिलाड़ी',
    guestATicTacToeAi: 'कंप्यूटर के खिलाफ खेलें',
    guestQReverseTarget: 'किस सैंपल साइट को हम खोलकर देखें?',
    guestAReverseStorefront: 'नमूना स्टोरफ्रंट',
    guestAReverseSaas: 'नमूना SaaS लैंडिंग पेज',
    guestAReverseDocs: 'नमूना दस्तावेज़ साइट',
    guestQReverseDepth: 'रीबिल्ड कितना आगे जाए?',
    guestAReverseMap: 'केवल घटक नक्शा और क्लोन योजना',
    guestAReverseFull: 'पेज को वेबऐप के रूप में फिर बनाएं',
    guestQDocsTopic: 'समीक्षा किए गए दस्तावेज़ों में मैं क्या खोजूं?',
    guestADocsAdlc: 'Agentic Development Life Cycle क्या है?',
    guestADocsPlanner: 'प्लानर काम को कैसे बांटता है?',
    guestADocsEgress: 'एजेंट से क्रेडेंशियल कैसे दूर रखे जाते हैं?',
    guestQDocsResult: 'डेमो सत्र और क्या कर सकता है, देखना चाहेंगे?',
    guestADocsBuildNext: 'हां — मुझे एक एप्लिकेशन बनाकर दें',
    guestADocsStop: 'नहीं, बस इतना काफ़ी है',
    guestQCustomiseAccent: 'आपकी साइट लाइव है। ऐक्सेंट रंग बदलें?',
    guestAAccentEmerald: 'एमरॉल्ड',
    guestAAccentAmber: 'एम्बर',
    guestAAccentKeep: 'जैसे है वैसे रखें',
    guestQCustomiseFeature: 'जाने से पहले एक और चीज़ जोड़ें?',
    guestAFeaturePage: 'एक और पेज',
    guestAFeatureFooter: 'संपर्क विवरण वाला फ़ुटर',
    guestAFeatureNone: 'और कुछ नहीं',
    guestQCustomiseDone: 'और कुछ?',
    guestADoneRestart: 'दूसरा डेमो सत्र शुरू करें',
    guestADoneStop: 'नहीं, मैं पूरा हो गया',
    guestDemoReplyTitle: 'गेस्ट डेमो',
    guestDemoPreviewTitle: 'आपका प्रीव्यू अभी भी लाइव है',
    guestDemoOpenPreview: 'प्रीव्यू खोलें',
    guestDemoEnd: 'यह डेमो यहीं खत्म होता है।',
    guestDemoEndBody: 'असल में चलाने के लिए साइन इन करें, या नीचे दूसरा विकल्प चुनें — हर क्लिक नया सत्र खोलता है।',
    guestDemoRestartTitle: 'दूसरा डेमो शुरू करें',
    guestDemoRestartBody: 'यह सत्र बंद हो चुका है। नीचे कोई भी विकल्प चुनें — हर क्लिक नया सत्र खोलता है।',
    guestDemoStopped: 'इस डेमो सत्र ने अपनी सीमा पा ली है।',
    guestMessageCap: 'यह डेमो सत्र {messages} संदेश रखता है। आगे जारी रखने के लिए साइन इन करें।',
    guestDemoFlowTitle: 'इस रन में जो बना',
    guestDemoSimulatedNotice: 'सिम्युलेटेड प्रीव्यू — क्लस्टर पर कुछ भी लागू नहीं किया गया।',
    guestDemoArtifactSummary: 'यह रन कौन सी एजेंट विन्यास लागू करेगा',
    guestDemoPreviewSkipped: 'इस तैनाती में प्रीव्यू प्रकाशन चालू नहीं है, इसलिए यह कदम छोड़ा गया।',
    guestDemoStepPlan: 'बिल्ड की योजना बनाएं',
    guestDemoStepSkill: 'डेमो स्किल माउंट करें',
    guestDemoStepCrset: 'kagent एजेंट रेंडर करें',
    guestDemoStepDeploy: 'वेबऐप के रूप में तैनात करें',
    guestDemoStepLiveUrl: 'प्रीव्यू URL {days} दिन तक लाइव',
    guestFollowupHint: 'एक चुनें — जवाब तय हैं, इसलिए टाइप करने को कुछ नहीं।',
    guestFollowupGroup: 'एक चुनें',
    guestDocsSearching: 'समीक्षा किए गए दस्तावेज़ों में खोज हो रही है…',
    guestDocsResultTitle: 'दस्तावेज़ों में क्या कहा गया है',
    guestDocsResultBody: '{count} इंडेक्स किए दस्तावेज़ों में से — पूरा जवाब, वर्कस्पेस मेमरी के साथ, साइन इन के बाद उपलब्ध।',
    guestDocsNoResults: 'समीक्षा किए दस्तावेज़ों में उससे मेल खाती कोई बात नहीं। साइन इन करके अपने वर्कस्पेस में पूछें।',
    guestSessionExpired: 'इस डेमो सत्र की मियाद पूरी। नया सत्र शुरू करने के लिए एक विकल्प चुनें।',
    guestStepStale: 'इस कदम का जवाब पहले ही दिया जा चुका है। नया सत्र शुरू करने के लिए एक विकल्प चुनें।',
    guestDemoSignedIn: 'आप साइन इन हैं, इसलिए यहाँ गेस्ट डेमो की ज़रूरत नहीं।',
    guestDemoRateLimited: 'यह जल्दी था — गेस्ट डेमो हर पते के लिए सीमित है। कुछ पल रुककर फिर कोशिश करें।',
    guestDemoFailed: 'गेस्ट डेमो आगे नहीं चल सका।',
    contextAppliesTo: 'नया काम दर्ज होता है',
    switchingTo: 'बदल रहा है',
    contextNoOrganization: 'कोई संगठन नहीं',
    actors: 'एक्टर रन',
    actorsSub: 'चल रहे, रुके और अटके एक्टर',
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
    authTitle: 'Software Factory में साइन इन करें',
    authDescription: 'इस कार्यक्षेत्र तक पहुँचने के लिए अपने संगठन के खाते का उपयोग करें।',
    continueWithGoogle: 'Google के साथ जारी रखें',
    continueWithMicrosoft: 'Microsoft के साथ जारी रखें',
    whySignIn: 'मुझे साइन इन करने की आवश्यकता क्यों है?',
    authDetails: 'आप Firebase के ज़रिए Google या Microsoft से साइन इन करते हैं; किसी कार्यक्षेत्र अनुरोध के Software Factory तक पहुँचने से पहले गेटवे आपके Firebase ID टोकन की जाँच करता है।',
    authenticationFailed: 'हम आपके सत्र की जाँच नहीं कर सके। फिर से साइन इन करने का प्रयास करें।',
    sessionExpired: 'आपके सत्र की अवधि समाप्त हो गई है। जारी रखने के लिए फिर से साइन इन करें।',
    details: 'विवरण',
    retry: 'पुनः प्रयास करें',
  },
  mr: {
    language: 'भाषा',
    accountAndContext: 'खाते आणि संदर्भ',
    softwareFactoryProject: 'Software Factory प्रकल्प',
    noOrganization: 'कोणतीही संस्था उपलब्ध नाही',
    noSoftwareFactoryProject: 'कोणताही Software Factory प्रकल्प उपलब्ध नाही',
    contextUnavailable: 'संस्थेचा संदर्भ सध्या उपलब्ध नाही.',
    regionalLanguages: 'प्रादेशिक',
    nationalLanguages: 'राष्ट्रीय',
    internationalLanguages: 'आंतरराष्ट्रीय',
    otherLanguages: 'इतर',
    recommended: 'शिफारस केलेले',
    invitation: 'आमंत्रण',
    invitationTitle: 'या Software Factory संस्थेत सामील व्हा',
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
    guestBannerTitle: 'तुम्ही पाहुण्या म्हणून ब्राउझ करत आहात',
    guestBannerBody: 'हे कार्यक्षेत्र फक्त-वाचनीय आहे आणि काहीही जतन होत नाही: एजंट कोणत्याही संस्थेशिवाय उत्तरे देते. तुमच्या संस्था व प्रकल्पांमध्ये काम चालवण्यासाठी साइन इन करा.',
    guestBannerDismiss: 'बंद करा',
    guestOnboardingEyebrow: 'गेस्ट डेमो',
    guestOnboardingTitle: 'हा डेमो कसा काम करतो',
    guestOnboardingBody: 'तुम्ही पाहुण्या म्हणून ब्राउझ करत आहात, त्यामुळे असिस्टंट टाईप करण्याऐवजी क्लिक स्वीकारतो. एक पर्याय निवडा, आणि खरा रन काय करतो ते तो दाखवेल.',
    guestOnboardingStep1: 'चॅटच्या खाली स्टार्टर पर्याय निवडा. टाईप करण्याचे काही नाही.',
    guestOnboardingStep2: 'दिलेल्या बटनांनी प्रश्नांची उत्तरे द्या — प्रत्येक उत्तर एक वेरिएशन निवडते.',
    guestOnboardingStep3: 'रन पहा: आराखडा, कोणता एजेंट तयार होईल, आणि त्या आराखड्यातून बनलेली प्रिव्ह्यू साइट.',
    guestOnboardingStep4: 'प्रिव्ह्यू आणि हे संवाद एक दिवस राहतील. तुमचे काम जपण्यासाठी आणि खरोखर चालवण्यासाठी साइन इन करा.',
    guestOnboardingReviewed: 'मी हे पाहून घेतले आहे',
    guestOnboardingSkip: 'आत्तासाठी वगळा',
    guestOnboardingClose: 'बंद करा',
    guestHeroEyebrow: 'गेस्ट डेमो · खात्याची गरज नाही',
    guestHeroTitle: 'रन काय करतो ते पहा — टाईप न करता, क्लिक करून.',
    guestHeroBody: 'खाली स्टार्टर पर्याय निवडा; डेमो त्याचा आराखडा बनवतो, कोणता एजेंट सेट तयार होईल ते दाखवतो, आणि प्रिव्ह्यू साइट प्रसिद्ध करतो. प्रत्येक उत्तर बटण आहे: टाईप करण्याचे काही नाही.',
    guestRailHeading: 'गेस्ट डेमो',
    guestRailBadge: 'खाते नाही',
    guestRailCopy: 'प्रत्येक क्लिक आमच्या नमुना साईटंवर स्क्रिप्टेड डेमो चालवतो. तुमचा इतिहास आणि वर्कस्पेस क्रियापदार्थ पाहण्यासाठी साइन इन करा.',
    guestThreadsLabel: 'गेस्ट डेमो प्रवेश',
    guestToolbarChip: 'फक्त स्क्रिप्टेड डेमो',
    guestRailTitle: 'फक्त-वाचन, आणि जाणूनबुजून',
    guestRailBody: 'गेस्ट डेमो संघटना, प्रकल्प, संवाद आणि रन क्रियापदार्थांपासून वेगळा आहे — त्यांसाठी खाते हवे.',
    guestRestrictedCardTitle: 'पाहुणे काय करू शकत आणि काय करू शकत नाहीत',
    guestIntroTitle: 'टाईप करण्याचे काही नाही — एक पर्याय निवडा.',
    guestIntroBody: 'खालील स्टार्टर बटणे स्क्रिप्टेड डेमो चालवतात: आराखडा, कोणती एजेंट रचना तयार होईल, आणि एक दिवस राहणारी प्रिव्ह्यू साइट. साइन इन पर्यंत टेंट डेटा आणि खरे एजेंट रन बंद राहतात.',
    guestRestrictedNotice: 'मर्यादित प्रवेश: तुम्ही पाहुण्या म्हणून ब्राउझ करत आहात. खालीून पर्याय निवडा — मोकळा मजकूर, टेंट डेटा आणि एजेंट रन यांसाठी खाते हवे.',
    guestDataNotRetrievable: 'गेस्ट संवाद खात्याशी जोडलेले नसतात आणि नंतर मिळत नाहीत. तुमचा इतिहास जपण्यासाठी साइन इन करा.',
    guestPreviewExpiryNotice: 'प्रत्येक डेमो सत्र आणि त्यातून बनलेली साइट {days} दिवस उपलब्ध राहते, मग हटवली जाते.',
    guestSignInCta: 'पूर्व अनुभवासाठी साइन इन करा',
    guestComposerHint: 'यातून एक निवडा — गेस्ट डेमोमध्ये टेक्स्ट बॉक्स नाही, कारण पाहुण्याकडून वर्णन मागितले जात नाही.',
    guestStarterGroup: 'गेस्ट डेमो स्टार्टर पर्याय',
    guestStarterLoading: 'डेमो पर्याय लोड होत आहेत…',
    guestStarterUnavailable: 'डेमो पर्याय सध्या उपलब्ध नाहीत.',
    guestStarterRetry: 'पुन्हा प्रयत्न करा',
    guestCommandEcho: 'कळले — मी काय सेट अप करू शकतो ते येथे आहे.',
    guestCmdHelloWorld: 'माझे hello-world ॲप्लिकेशन तयार करा',
    guestCmdTicTacToe: 'माझे टिक-टॅक-टो ॲप्लिकेशन तयार करा',
    guestCmdReverseEngineer: 'एका वेबसाइटचे रिव्हर्स इंजिनिअरिंग करा',
    guestCmdDocsSearch: 'समीक्षित कागदपत्रांमध्ये शोधा',
    guestQHelloWorldStack: 'hello-world ॲप कोणता स्टॅक वापरावा?',
    guestAHelloWorldNode: 'Node.js',
    guestAHelloWorldStatic: 'स्टॅटिक HTML',
    guestQHelloWorldTheme: 'सुरुवातीचा देखाव निवडा.',
    guestAThemeIndigo: 'इंडिगो',
    guestAThemeEmerald: 'एमरॉल्ड',
    guestQTicTacToeTheme: 'कोणता बोर्ड थीम?',
    guestAThemeClassic: 'क्लासिक लाइट',
    guestAThemeDark: 'डार्क',
    guestQTicTacToeMode: 'कोण कोणाविरुद्ध खेळेल?',
    guestATicTacToeLocal: 'एका उपकरणावर दोन खेळाडू',
    guestATicTacToeAi: 'संगणकाविरुद्ध खेळा',
    guestQReverseTarget: 'कोणत्या नमुना साइटचे विश्लेषण करू?',
    guestAReverseStorefront: 'नमुना स्टोअरफ्रंट',
    guestAReverseSaas: 'नमुना SaaS लँडिंग पेज',
    guestAReverseDocs: 'नमुना कागदपत्र साइट',
    guestQReverseDepth: 'रीबिल्ड किती पुढे जावे?',
    guestAReverseMap: 'फक्त घटक नकाशा आणि क्लोन आराखडा',
    guestAReverseFull: 'पेज वेबॲप म्हणून पुन्हा तयार करा',
    guestQDocsTopic: 'समीक्षित कागदपत्रांमध्ये मी काय शोधावे?',
    guestADocsAdlc: 'Agentic Development Life Cycle म्हणजे काय?',
    guestADocsPlanner: 'प्लॅनर काम कसे विभागतो?',
    guestADocsEgress: 'एजेंटपासून क्रेडेन्शियल कसे दूर ठेवले जातात?',
    guestQDocsResult: 'डेमो सत्र आणखी काय करू शकते ते पाहायचे?',
    guestADocsBuildNext: 'होय — मला एक ॲप्लिकेशन तयार करा',
    guestADocsStop: 'नाही, एवढे पुरेसे',
    guestQCustomiseAccent: 'तुमची साइट लाइव्ह आहे. ॲक्सेंट रंग बदलणार?',
    guestAAccentEmerald: 'एमरॉल्ड',
    guestAAccentAmber: 'अंबर',
    guestAAccentKeep: 'तसेच ठेवा',
    guestQCustomiseFeature: 'जाण्यापूर्वी आणखी एक गोष्ट जोडणार?',
    guestAFeaturePage: 'दुसरे पान',
    guestAFeatureFooter: 'संपर्क तपशील असलेले फूटर',
    guestAFeatureNone: 'आणखी काही नाही',
    guestQCustomiseDone: 'आणखी काही?',
    guestADoneRestart: 'दुसरे डेमो सत्र सुरू करा',
    guestADoneStop: 'नाही, मी पूर्ण झालो',
    guestDemoReplyTitle: 'गेस्ट डेमो',
    guestDemoPreviewTitle: 'तुमचा प्रिव्ह्यू अजून लाइव्ह आहे',
    guestDemoOpenPreview: 'प्रिव्ह्यू उघडा',
    guestDemoEnd: 'या डेमोचा शेवट झाला.',
    guestDemoEndBody: 'खरोखर चालवण्यासाठी साइन इन करा, किंवा खाली दुसरा पर्याय निवडा — प्रत्येक क्लिक नवे सत्र उघडते.',
    guestDemoRestartTitle: 'दुसरा डेमो सुरू करा',
    guestDemoRestartBody: 'हे सत्र बंद झाले आहे. खाली कोणताही पर्याय निवडा — प्रत्येक क्लिक नवे सत्र उघडते.',
    guestDemoStopped: 'या डेमो सत्राने त्याची मर्यादा गाठली.',
    guestMessageCap: 'या डेमो सत्रात {messages} संदेश असतात. पुढे चालू ठेवण्यासाठी साइन इन करा.',
    guestDemoFlowTitle: 'या रनमध्ये जे तयार झाले',
    guestDemoSimulatedNotice: 'सिम्युलेटेड प्रिव्ह्यू — क्लस्टरवर काहीही लागू करण्यात आले नाही.',
    guestDemoArtifactSummary: 'या रनने कोणती एजेंट रचना लागू केली असती',
    guestDemoPreviewSkipped: 'या डिटेलमेंटमध्ये प्रिव्ह्यू प्रकाशन चालू नाही, म्हणून हे पाऊल वगळले.',
    guestDemoStepPlan: 'बिल्डचा आराखडा करा',
    guestDemoStepSkill: 'डेमो स्किल माउंट करा',
    guestDemoStepCrset: 'kagent एजेंट रेंडर करा',
    guestDemoStepDeploy: 'वेबॲप म्हणून डिटेलॉय करा',
    guestDemoStepLiveUrl: 'प्रिव्ह्ह URL {days} दिवस लाइव्ह',
    guestFollowupHint: 'एक निवडा — उत्तरे ठरलेली आहेत, म्हणून टाईप करण्याचे काही नाही.',
    guestFollowupGroup: 'एक निवडा',
    guestDocsSearching: 'समीक्षित कागदपत्रांमध्ये शोध सुरू आहे…',
    guestDocsResultTitle: 'कागदपत्रांत काय म्हटले आहे',
    guestDocsResultBody: '{count} अनुक्रमणिका केलेल्या कागदपत्रांतून — पूर्ण उत्तर, वर्कस्पेस मेमरीसह, साइन इन केल्यावर उपलब्ध.',
    guestDocsNoResults: 'समीक्षित कागदपत्रांत त्या जुळणारे काही नाही. साइन इन करून तुमच्या वर्कस्पेसमध्ये विचारा.',
    guestSessionExpired: 'या डेमो सत्रची मुदत संपली. नवे सत्र सुरू करण्यासाठी एक पर्याय निवडा.',
    guestStepStale: 'या पाऊलाचे उत्तर आधीच दिले आहे. नवे सत्र सुरू करण्यासाठी एक पर्याय निवडा.',
    guestDemoSignedIn: 'तुम्ही साइन इन आहात, म्हणून येथे गेस्ट डेमोची गरज नाही.',
    guestDemoRateLimited: 'ते जलद होते — गेस्ट डेमो प्रत्येक पत्त्यासाठी मर्यादित आहे. थोडा वेळ थांबून पुन्हा प्रयत्न करा.',
    guestDemoFailed: 'गेस्ट डेमो पुढे चालू शकला नाही.',
    agentPauseJob: 'कार्यक्षेत्र उपलब्ध नसल्यामुळे ही जॉब थांबली.',
    callRecorder: 'कॉल रेकॉर्डर',
    callRecorderSub: 'एजंट सत्रे रेकॉर्ड करा',
    contextAppliesTo: 'नवीन काम नोंदले जाते',
    switchingTo: 'बदलत आहे',
    contextNoOrganization: 'कोणतीही संस्था नाही',
    actors: 'अ‍ॅक्टकर रन',
    actorsSub: 'सुरू, थांबवलेले आणि अडकलेले अ‍ॅक्टकर',
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
    authTitle: 'Software Factory मध्ये साइन इन करा',
    authDescription: 'या कार्यक्षेत्रात प्रवेश करण्यासाठी तुमच्या संस्थेचे खाते वापरा.',
    continueWithGoogle: 'Google सह पुढे जा',
    continueWithMicrosoft: 'Microsoft सह पुढे जा',
    whySignIn: 'मला साइन इन का करावे लागते?',
    authDetails: 'तुम्ही Firebase द्वारे Google किंवा Microsoft वापरून साइन इन करता; कार्यक्षेत्राची कोणतीही विनंती Software Factory पर्यंत पोहोचण्यापूर्वी गेटवे तुमचे Firebase ID टोकन तपासतो.',
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

/**
 * Placeholders a caller had to fill in at render time (a count, a retention
 * window), carried on the node so a later locale pass fills in the same values.
 * Without this the static pass re-reads the raw template and the reader sees
 * "{days}". Bad JSON reads as no arguments rather than throwing.
 */
function parseI18nArgs(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function applyStaticTranslations(root = document) {
  const nodes = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches('[data-i18n]')) nodes.push(root);
  root.querySelectorAll?.('[data-i18n]').forEach((node) => nodes.push(node));
  for (const node of nodes) {
    const key = node.dataset.i18n;
    const value = t(key, node.dataset.i18nFallback || node.textContent, parseI18nArgs(node.dataset.i18nArgs));
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
  window.dispatchEvent(new CustomEvent('software-factory:locale-changed', { detail: { locale } }));
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
