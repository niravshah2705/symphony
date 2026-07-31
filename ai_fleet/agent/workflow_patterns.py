"""Bounded workflow-pattern catalog and validator.

Faithful port of ``packages/shared/src/agent/workflow-patterns.js``. Pure: no
I/O, no network, no LLM. Only declarative names and bounded counters are
accepted; executable code and tool arguments are intentionally outside this
catalog.
"""

import copy
import math
import re

# Immutability by convention (mirrors JS Object.freeze).
PATTERNS = [
    {
        "id": "sequential",
        "label": "Sequential",
        "description": "Guide one runtime session through focused steps in a fixed order.",
        "summary": "Guide one runtime session through focused steps in a fixed order.",
        "bestFor": "Predictable work with clear dependencies between stages.",
        "steps": ["Understand", "Act", "Verify"],
        "config": {"field": "steps", "minimum": 2, "maximum": 12},
    },
    {
        "id": "parallel",
        "label": "Parallel / fan-out",
        "description": "Guide capable runtimes to split independent investigation, keep writes serialized, and synthesize the result.",
        "summary": "Guide capable runtimes to split independent investigation and synthesize the result.",
        "bestFor": "Research or review work that can be investigated independently inside one runtime session.",
        "steps": ["Split", "Investigate", "Synthesize"],
        "config": {"field": "branches", "minimum": 2, "maximum": 8, "optional": ["join"]},
    },
    {
        "id": "evaluator",
        "label": "Evaluator / retry",
        "description": "Guide one runtime session to produce a candidate, evaluate it, and repair concrete gaps.",
        "summary": "Guide one runtime session to evaluate its own candidate and repair concrete gaps.",
        "bestFor": "Outputs that benefit from an explicit quality pass before validation.",
        "steps": ["Generate", "Evaluate", "Repair"],
        "config": {"required": ["worker", "evaluator"], "maxAttempts": {"minimum": 1, "maximum": 5, "default": 3}},
    },
    {
        "id": "supervisor",
        "label": "Supervisor / handoff",
        "description": "Guide capable runtimes to delegate bounded specialist work, review it, and integrate verified results.",
        "summary": "Guide capable runtimes to delegate, review, and integrate bounded specialist work.",
        "bestFor": "Requests that span specialties and benefit from explicit review inside one runtime session.",
        "steps": ["Route", "Review", "Integrate"],
        "config": {"required": ["supervisor", "specialists"], "specialists": {"minimum": 2, "maximum": 8}, "maxHandoffs": {"minimum": 1, "maximum": 20, "default": 6}},
    },
]

IDS = {pattern["id"] for pattern in PATTERNS}
ALIASES = {
    "parallel-fan-out": "parallel",
    "parallel/fan-out": "parallel",
    "evaluator-retry": "evaluator",
    "evaluator/retry": "evaluator",
    "supervisor-handoff": "supervisor",
    "supervisor/handoff": "supervisor",
}

# JS: /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u — Python `re` has no \p{L}/\p{N}. The
# first class (letter or number, no underscore) becomes [^\W_]; the second class
# (letter, number, space, underscore, dot, dash) equals [\w .-] since \w already
# includes underscore. re.UNICODE keeps letter/number matching Unicode-aware.
_AGENT_RE = re.compile(r"^[^\W_][\w .\-]*$", re.UNICODE)


def catalog():
    # JSON round-trip deep clone in JS -> deepcopy of plain dicts/lists here.
    return [copy.deepcopy(pattern) for pattern in PATTERNS]


def _plain_object(value):
    # JS: value && typeof value === 'object' && !Array.isArray(value).
    # A JS plain object maps to a Python dict (lists map to JS arrays).
    return isinstance(value, dict)


def pattern_id(value):
    candidate = str(value or "").strip().lower()
    if candidate in IDS:
        return candidate
    return ALIASES.get(candidate, "")


def _clean_agent(value, field, errors):
    if not isinstance(value, str):
        errors.append(f"{field} must be a short agent or step identifier.")
        return ""
    result = value.strip()
    if not result or len(result) > 80 or not _AGENT_RE.match(result):
        errors.append(
            f"{field} must be 1–80 characters using letters, numbers, spaces, dot, dash, or underscore."
        )
        return ""
    return result


def _clean_list(value, field, minimum, maximum, errors):
    if not isinstance(value, list):
        errors.append(f"{field} must be a list with {minimum}–{maximum} entries.")
        return []
    if len(value) < minimum or len(value) > maximum:
        errors.append(f"{field} must contain {minimum}–{maximum} entries.")
    cleaned = [
        _clean_agent(item, f"{field}[{index}]", errors)
        for index, item in enumerate(value[:maximum])
    ]
    usable = [item for item in cleaned if item]
    if len({item.lower() for item in usable}) != len(usable):
        errors.append(f"{field} entries must be unique.")
    return usable


def _js_number(value):
    # Mirror JS Number(value) for the value shapes this validator sees.
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if value is None:
        return 0
    if isinstance(value, str):
        stripped = value.strip()
        if stripped == "":
            return 0
        try:
            return float(stripped)
        except ValueError:
            return math.nan
    return math.nan


def _js_is_integer(number):
    # Mirror JS Number.isInteger: finite and integral.
    if isinstance(number, bool):
        return False
    if isinstance(number, int):
        return True
    if isinstance(number, float):
        if math.isnan(number) or math.isinf(number):
            return False
        return number.is_integer()
    return False


def _bounded_config_integer(value, field, minimum, maximum, fallback, errors):
    if value is None or value == "":
        return fallback
    number = _js_number(value)
    if not _js_is_integer(number) or number < minimum or number > maximum:
        errors.append(f"{field} must be an integer from {minimum} to {maximum}.")
        return fallback
    return number


def validate_workflow_pattern(input):
    if not _plain_object(input):
        return {"valid": False, "errors": ["A workflow definition object is required."], "workflow": None}
    resolved_id = pattern_id(input.get("patternId") or input.get("pattern") or input.get("id"))
    if not resolved_id:
        return {"valid": False, "errors": ["Choose a supported workflow pattern."], "workflow": None}
    config = input.get("config") if _plain_object(input.get("config")) else input
    errors = []

    if resolved_id == "sequential":
        normalized = {"steps": _clean_list(config.get("steps"), "steps", 2, 12, errors)}
    elif resolved_id == "parallel":
        normalized = {"branches": _clean_list(config.get("branches"), "branches", 2, 8, errors)}
        join = config.get("join")
        if join is not None and join != "":
            normalized["join"] = _clean_agent(join, "join", errors)
    elif resolved_id == "evaluator":
        normalized = {
            "worker": _clean_agent(config.get("worker"), "worker", errors),
            "evaluator": _clean_agent(config.get("evaluator"), "evaluator", errors),
            "maxAttempts": _bounded_config_integer(config.get("maxAttempts"), "maxAttempts", 1, 5, 3, errors),
        }
        if (
            normalized["worker"]
            and normalized["evaluator"]
            and normalized["worker"].lower() == normalized["evaluator"].lower()
        ):
            errors.append("worker and evaluator must be different agents.")
    else:
        normalized = {
            "supervisor": _clean_agent(config.get("supervisor"), "supervisor", errors),
            "specialists": _clean_list(config.get("specialists"), "specialists", 2, 8, errors),
            "maxHandoffs": _bounded_config_integer(config.get("maxHandoffs"), "maxHandoffs", 1, 20, 6, errors),
        }
        if normalized["supervisor"] and any(
            specialist.lower() == normalized["supervisor"].lower()
            for specialist in normalized["specialists"]
        ):
            errors.append("supervisor must not also appear in specialists.")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "workflow": None if errors else {"patternId": resolved_id, "config": normalized},
    }
