"""Deterministic policy-and-intent gate for the workspace router.

Faithful port of ``packages/shared/src/agent/workspace-router.js``. Pure: no
I/O, no network, no LLM. The classifier runs before retrieval, models, tools,
diagnostics, or mutations. Defensive fraud questions remain allowed; only
requests that ask the agent to facilitate abuse are rejected.
"""

import re

MAX_INPUT_CHARS = 8_000

# Immutability by convention (mirrors JS Object.freeze).
ROUTES = {
    "salutation": {
        "label": "Greeting",
        "title": "Good to see you.",
        "answer": "Hello! I’m ready. Ask a question or tell me what you want to move forward.",
    },
    "knowledge": {
        "label": "Knowledge search",
        "title": "Searching workspace knowledge",
        "answer": "I checked connected business memory, projects, and recent workspace activity for relevant details.",
    },
    "unsafe": {
        "label": "Protected route",
        "title": "I can’t help with that request.",
        "answer": "I can’t help create sexual exploitation, scams, fraud, or deceptive content. This workspace is for lawful work that grows durable businesses and improves people’s lives. I can help reshape the request into a safe, legitimate goal.",
    },
    "business": {
        "label": "Business workflow",
        "title": "Business workflow prepared",
        "answer": "I ran the request through the fraud gate, mapped the revenue signals, prepared business memory and architecture, and broke the work into scheduler-ready segments.",
    },
    "build": {
        "label": "Build request",
        "title": "Let’s build that.",
        "answer": "I’ll help set up the project and hand it to the planner. Confirm each step below.",
    },
    "troubleshooting": {
        "label": "Troubleshooting",
        "title": "Checking diagnostics and logs",
        "answer": "I checked live readiness signals and recent run logs, then pulled the most useful next action into the side panel.",
    },
    "implementation": {
        "label": "Project task",
        "title": "Implementation task drafted",
        "answer": "I turned the requested implementation change into a project-task draft. Review the project and task details in the side panel before creating it.",
    },
    "general": {
        "label": "Thinker route",
        "title": "I’ve organized the request.",
        "answer": "I clarified the outcome and prepared a practical next move with the configured thinking model.",
    },
}


class WorkspaceRouterError(Exception):
    """Raised for invalid router input. Mirrors the JS WorkspaceRouterError."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.name = "WorkspaceRouterError"
        self.message = message
        self.status = status


# --- Precompiled classifier patterns (all case-insensitive, mirroring /i). ---

_SCAM_ACTION = re.compile(
    r"\b(?:help|how|write|create|make|run|launch|send|build|teach|show)\b"
    r".{0,70}\b(?:scam|phish(?:ing)?|fake invoice|ponzi|carding|identity theft|"
    r"money laundering|steal|defraud|impersonat(?:e|ion))\b",
    re.IGNORECASE,
)
_SCAM_INTENT = re.compile(
    r"\b(?:i want to|let'?s|can i|give me a way to)\b"
    r".{0,50}\b(?:scam|phish|defraud|steal|launder|impersonate)\b",
    re.IGNORECASE,
)
_DIRECT_FRAUD = re.compile(
    r"\b(?:steal (?:money|cards?|credentials)|launder money|"
    r"bypass fraud checks?|clone credit cards?)\b",
    re.IGNORECASE,
)
_EXPLICIT_SEXUAL = re.compile(
    r"\b(?:create|generate|write|show|send|sell|promote|give me|i want|find me|where can i)\b"
    r".{0,60}\b(?:porn(?:ographic)?|explicit sexual|sexual exploitation|nudes?|escort scam)\b",
    re.IGNORECASE,
)
_DEFENSIVE_FRAUD = re.compile(
    r"\b(?:prevent|detect|recognize|report|avoid|protect|anti-fraud|fraud prevention|"
    r"is this|check whether|could this be)\b",
    re.IGNORECASE,
)

_SALUTATION = re.compile(
    r"^(?:hi|hello|hey|good (?:morning|afternoon|evening)|namaste|howdy|greetings)[!.?\s]*$",
    re.IGNORECASE,
)
_CHANGE_VERB = re.compile(
    r"\b(?:modify|change|update|fix|refactor|implement|remove|replace|rename|add|redesign|adjust)\b",
    re.IGNORECASE,
)
_IMPLEMENTATION_NOUN = re.compile(
    r"\b(?:implementation|code|component|screen|page|api|endpoint|function|module|database|"
    r"schema|button|form|layout|workflow|feature|file|repository|repo|ui)\b",
    re.IGNORECASE,
)
_TROUBLESHOOTING = re.compile(
    r"\b(?:troubleshoot|debug|diagnos(?:e|is|tic)|logs?|stack trace|exception|error|failed|"
    r"failure|not working|service down|timeout|latency|crash(?:ed|ing)?)\b",
    re.IGNORECASE,
)
_KNOWLEDGE = re.compile(
    r"\b(?:rag|document(?:s|ation)?|docs|knowledge base|memory|remember|workspace history|"
    r"search (?:for|my|our|the)|look up|find (?:in|my|our))\b",
    re.IGNORECASE,
)
_BUILD_VERB = re.compile(
    r"\b(?:create|build|make|develop|design|prototype|scaffold|architect|spin up|stand up|"
    r"kick off|start building)\b",
    re.IGNORECASE,
)
_BUILD_NOUN = re.compile(
    r"\b(?:software|apps?|application|web ?app|website|platform|tool|system|service|product|"
    r"saas|mvp|prototype|bot|assistant|dashboard|marketplace|portal|extension|plugin)\b",
    re.IGNORECASE,
)
_BUSINESS = re.compile(
    r"\b(?:business|startup|revenue|moneti[sz]e|pricing|sales|customer|market|go-to-market|"
    r"growth|profit|margin|subscription|business model|launch|founder|venture|product idea)\b",
    re.IGNORECASE,
)

_WHITESPACE = re.compile(r"\s+")


def normalize_message(value):
    if not isinstance(value, str):
        raise WorkspaceRouterError("input must be a string.")
    input_text = _WHITESPACE.sub(" ", value).strip()
    if not input_text:
        raise WorkspaceRouterError("Describe what you want to ask or do.")
    if len(input_text) > MAX_INPUT_CHARS:
        raise WorkspaceRouterError(
            f"input must be {MAX_INPUT_CHARS:,} characters or fewer."
        )
    return input_text


def _result(intent, input_text, confidence):
    return {"intent": intent, "input": input_text, "confidence": confidence, **ROUTES[intent]}


def classify_intent(value):
    input_text = normalize_message(value)

    unsafe = (
        (
            (_SCAM_ACTION.search(input_text) or _SCAM_INTENT.search(input_text))
            and not _DEFENSIVE_FRAUD.search(input_text)
        )
        or _DIRECT_FRAUD.search(input_text)
        or _EXPLICIT_SEXUAL.search(input_text)
    )
    if unsafe:
        return _result("unsafe", input_text, 0.99)

    if len(input_text) <= 80 and _SALUTATION.search(input_text):
        return _result("salutation", input_text, 0.99)

    if _CHANGE_VERB.search(input_text) and _IMPLEMENTATION_NOUN.search(input_text):
        return _result("implementation", input_text, 0.92)

    if _TROUBLESHOOTING.search(input_text):
        return _result("troubleshooting", input_text, 0.94)

    if _KNOWLEDGE.search(input_text):
        return _result("knowledge", input_text, 0.9)

    # A "build" request (create/build a product) precedes the business branch so
    # "Create X software" drives the guided project -> planner flow rather than
    # the business-analysis flow. Both a build verb and a product noun are required.
    if _BUILD_VERB.search(input_text) and _BUILD_NOUN.search(input_text):
        return _result("build", input_text, 0.9)

    if _BUSINESS.search(input_text):
        return _result("business", input_text, 0.9)

    return _result("general", input_text, 0.58)
