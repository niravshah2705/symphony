"""Tiny JSON-file backed store (port of packages/shared/src/store.js).

Holds local settings, the business->project mapping, the assumed role, agent
config, and enrichment jobs / memories / conversations / approval gates. All
updates return a new object (no in-place mutation). Secrets (API keys, OAuth
tokens) live only in this server-side file; routes mask them before returning.

Store keys stay camelCase (browser API contract). Functions are snake_case.
"""

from __future__ import annotations

import copy
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import CONFIG
from .agent.model_presets import (
    MODEL_ROLES,
    get_preset,
    model_matches_preset,
    preset_for_model,
    public_catalog,
    settings_patch_for_preset,
)


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _uuid() -> str:
    return str(uuid.uuid4())


_PRESET_CATALOG = public_catalog()
_DEFAULT_LOCAL_PRESET = get_preset(_PRESET_CATALOG["defaults"]["local"])
_DEFAULT_HOSTED_PRESET = get_preset(_PRESET_CATALOG["defaults"]["hosted"])


def _recommended_preset(provider):
    return next((p for p in _PRESET_CATALOG["presets"] if p["provider"] == provider and p["recommended"]), None) or next(
        (p for p in _PRESET_CATALOG["presets"] if p["provider"] == provider), None
    )


def _configured_model(provider):
    if provider == "codex":
        return CONFIG.OAUTH.chatgptModel if CONFIG.OAUTH.backend == "chatgpt" else CONFIG.OAUTH.defaultModel
    if provider == "claude":
        return CONFIG.CLAUDE.defaultModel
    return _recommended_preset(provider)["model"]


def apply_legacy_hosted_reasoning_defaults(settings, stored_settings):
    for provider in ("codex", "claude"):
        effort_key = f"{provider}ReasoningEffort"
        adapter_key = f"{provider}ReasoningAdapter"
        missing_reasoning = effort_key not in stored_settings and adapter_key not in stored_settings
        model = stored_settings.get(f"{provider}Model") or _configured_model(provider)
        preset = preset_for_model(provider, model) if missing_reasoning else None
        if preset:
            settings[effort_key] = preset["parameters"]["reasoning"]["effort"]
            settings[adapter_key] = preset["capabilities"]["reasoningAdapter"]
    return settings


def settings_for_configured_model(preset, model=None):
    if model is None:
        model = _configured_model(preset["provider"])
    patch = settings_patch_for_preset(preset, {"model": model})
    if model_matches_preset(preset, model):
        return patch
    if preset["provider"] == "codex":
        return {
            **patch,
            "codexModel": model,
            "codexContextWindow": 128000,
            "codexMaxTokens": 4096,
            "codexTemperature": None,
            "codexReasoningEffort": "none",
            "codexReasoningAdapter": "none",
        }
    return {
        **patch,
        "claudeModel": model,
        "claudeContextWindow": 200000,
        "claudeMaxTokens": 4096,
        "claudeTemperature": None,
        "claudeReasoningEffort": "none",
        "claudeReasoningAdapter": "none",
        "claudeStreaming": True,
    }


_DEFAULT_OLLAMA_SETTINGS = settings_patch_for_preset(_recommended_preset("ollama"))
_DEFAULT_LMSTUDIO_SETTINGS = settings_patch_for_preset(_recommended_preset("lmstudio"))
_DEFAULT_OMLX_SETTINGS = settings_patch_for_preset(_recommended_preset("omlx"))
_DEFAULT_HUGGINGFACE_SETTINGS = settings_patch_for_preset(_recommended_preset("huggingface"))
_DEFAULT_CODEX_SETTINGS = settings_for_configured_model(_recommended_preset("codex"))
_DEFAULT_CLAUDE_SETTINGS = settings_for_configured_model(_recommended_preset("claude"))
_DEFAULT_ACTIVE_LOCAL_SETTINGS = settings_patch_for_preset(_DEFAULT_LOCAL_PRESET)
_DEFAULT_ACTIVE_HOSTED_SETTINGS = settings_for_configured_model(_DEFAULT_HOSTED_PRESET)
_DEFAULT_HOSTED_MODEL = _configured_model(_DEFAULT_HOSTED_PRESET["provider"])
_DEFAULT_HOSTED_PRESET_ID = _DEFAULT_HOSTED_PRESET["id"] if model_matches_preset(_DEFAULT_HOSTED_PRESET, _DEFAULT_HOSTED_MODEL) else "custom"


DEFAULT_AGENT_CONFIG = {
    "parallelProcessing": 2,
    "maxConcurrentCoders": int(CONFIG.CODER.maxConcurrent) or 3,
    "scheduleEnabled": True,
    "autoAssignLead": True,
    "autoLabelNewProjects": True,
    "createIssues": True,
    "addDependencies": True,
    "maxProjectsPerRun": 5,
    "maxMilestones": 6,
    "maxIssuesPerMilestone": 5,
    "enrichLabels": ["AI"],
    "intervalMinutes": 5,
    "evaluationApprovalWaitMinutes": 120,
}


def _build_default_settings():
    settings: dict = {
        "linearApiKey": "",
        "planningProvider": "linear",
        "jiraBaseUrl": "",
        "jiraEmail": "",
        "jiraApiToken": "",
        "asanaWorkspaceId": "",
        "asanaAccessToken": "",
        "repositoryProvider": "github",
        "repositoryUrl": "",
        "gitlabToken": "",
        "llmProvider": _DEFAULT_HOSTED_PRESET["provider"],
        "localLlmProvider": _DEFAULT_LOCAL_PRESET["provider"],
        "hostedLlmPresetId": _DEFAULT_HOSTED_PRESET_ID,
        "localLlmPresetId": _DEFAULT_LOCAL_PRESET["id"],
        "thinkingLlmProvider": _DEFAULT_HOSTED_PRESET["provider"],
        "thinkingLlmPresetId": _DEFAULT_HOSTED_PRESET_ID,
        "executionLlmProvider": _DEFAULT_HOSTED_PRESET["provider"],
        "executionLlmPresetId": _DEFAULT_HOSTED_PRESET_ID,
        "testingLlmProvider": _DEFAULT_HOSTED_PRESET["provider"],
        "testingLlmPresetId": _DEFAULT_HOSTED_PRESET_ID,
        "ollamaHost": "http://localhost:11434",
    }
    settings.update(_DEFAULT_OLLAMA_SETTINGS)
    settings["lmstudioHost"] = "http://localhost:1234"
    settings.update(_DEFAULT_LMSTUDIO_SETTINGS)
    settings["omlxHost"] = CONFIG.OMLX.defaultHost
    settings["omlxApiKey"] = ""
    settings.update(_DEFAULT_OMLX_SETTINGS)
    settings["huggingfaceHost"] = CONFIG.HUGGINGFACE.defaultHost
    settings["huggingfaceApiKey"] = ""
    settings.update(_DEFAULT_HUGGINGFACE_SETTINGS)
    settings.update(_DEFAULT_CODEX_SETTINGS)
    settings["codexContextMode"] = "trim"
    settings["codexTokens"] = None
    settings.update(_DEFAULT_CLAUDE_SETTINGS)
    settings.update(_DEFAULT_ACTIVE_LOCAL_SETTINGS)
    settings.update(_DEFAULT_ACTIVE_HOSTED_SETTINGS)
    settings.update(
        {
            "claudeTokens": None,
            "githubToken": "",
            "langsmithApiKey": "",
            "langsmithProject": "linear-manager",
            "langsmithEndpoint": "https://api.smith.langchain.com",
            "langsmithTracing": True,
            "agentRuntime": "deepagent",
            "workflowPattern": "sequential",
            "llmStreamRetries": CONFIG.LLM_STREAM_RETRIES,
        }
    )
    return settings


DEFAULT_STORE = {
    "settings": _build_default_settings(),
    "businesses": [
        {
            "id": "ota",
            "name": "OTA",
            "description": "Online Travel Agency — initial business.",
            "projectId": None,
            "repoProvider": "github",
            "createdAt": "2026-07-01T00:00:00.000Z",
        }
    ],
    "assumedRole": None,
    "agentConfig": DEFAULT_AGENT_CONFIG,
    "jobs": [],
    "memories": [],
    "conversations": [],
    "approvals": [],
}


def _ensure_data_dir():
    Path(CONFIG.DATA_DIR).mkdir(parents=True, exist_ok=True)


def _clone_default():
    return copy.deepcopy(DEFAULT_STORE)


def migrate_business_repositories(businesses):
    result = []
    for business in businesses:
        if not business or not isinstance(business, dict) or business.get("repoProvider") is not None:
            result.append(business)
        else:
            result.append({**business, "repoProvider": "github"})
    return result


def migrate_agent_config(config):
    next_ = {**config}
    if not isinstance(next_.get("enrichLabels"), list):
        next_["enrichLabels"] = [next_["enrichLabel"]] if next_.get("enrichLabel") else ["AI"]
    next_.pop("enrichLabel", None)
    if not next_.get("intervalMinutes"):
        next_["intervalMinutes"] = 5
    coders = next_.get("maxConcurrentCoders")
    try:
        coders_n = float(coders)
    except (TypeError, ValueError):
        coders_n = float("nan")
    if coders_n == coders_n and coders_n >= 1:
        next_["maxConcurrentCoders"] = min(8, int(coders_n))
    else:
        next_["maxConcurrentCoders"] = DEFAULT_AGENT_CONFIG["maxConcurrentCoders"]
    if not next_.get("evaluationApprovalWaitMinutes"):
        next_["evaluationApprovalWaitMinutes"] = DEFAULT_AGENT_CONFIG["evaluationApprovalWaitMinutes"]
    next_.pop("model", None)
    next_.pop("maxTokens", None)
    return next_


def read_store():
    _ensure_data_dir()
    if not os.path.exists(CONFIG.STORE_FILE):
        seed = _clone_default()
        write_store(seed)
        return seed
    try:
        with open(CONFIG.STORE_FILE, encoding="utf-8") as fh:
            parsed = json.load(fh)
        base = _clone_default()
        stored_settings = parsed.get("settings") or {}
        settings = {**base["settings"], **stored_settings}
        if "localLlmPresetId" not in stored_settings:
            settings["localLlmPresetId"] = "custom"
        if "hostedLlmPresetId" not in stored_settings:
            settings["hostedLlmPresetId"] = "custom"
        for role in MODEL_ROLES:
            provider_key = f"{role}LlmProvider"
            preset_key = f"{role}LlmPresetId"
            if provider_key not in stored_settings:
                settings[provider_key] = settings["llmProvider"]
                settings[preset_key] = settings["hostedLlmPresetId"]
        for prefix in ("ollama", "lmstudio", "codex", "claude", "huggingface"):
            effort_key = f"{prefix}ReasoningEffort"
            adapter_key = f"{prefix}ReasoningAdapter"
            if effort_key not in stored_settings:
                settings[effort_key] = None
            if adapter_key not in stored_settings:
                settings[adapter_key] = "none"
        apply_legacy_hosted_reasoning_defaults(settings, stored_settings)
        if "ollamaTemperature" not in stored_settings:
            settings["ollamaTemperature"] = 0
        if "lmstudioTemperature" not in stored_settings:
            settings["lmstudioTemperature"] = 0
        if "codexTemperature" not in stored_settings:
            settings["codexTemperature"] = 0
        for prefix in ("ollama", "lmstudio"):
            for suffix in ("TopP", "TopK", "RepeatPenalty"):
                key = f"{prefix}{suffix}"
                if key not in stored_settings:
                    settings[key] = None
        return {
            **base,
            **parsed,
            "settings": settings,
            "businesses": migrate_business_repositories(
                parsed["businesses"] if isinstance(parsed.get("businesses"), list) else base["businesses"]
            ),
            "assumedRole": parsed.get("assumedRole") or None,
            "agentConfig": migrate_agent_config({**base["agentConfig"], **(parsed.get("agentConfig") or {})}),
            "jobs": parsed["jobs"] if isinstance(parsed.get("jobs"), list) else [],
            "memories": parsed["memories"] if isinstance(parsed.get("memories"), list) else [],
            "conversations": parsed["conversations"] if isinstance(parsed.get("conversations"), list) else [],
            "approvals": parsed["approvals"] if isinstance(parsed.get("approvals"), list) else [],
        }
    except Exception:
        return _clone_default()


def write_store(store):
    _ensure_data_dir()
    with open(CONFIG.STORE_FILE, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=2)
    return store


# --------------------------- Settings / secrets ------------------------- #


def get_api_key():
    return read_store()["settings"].get("linearApiKey") or ""


def set_api_key(linear_api_key):
    current = read_store()
    return write_store({**current, "settings": {**current["settings"], "linearApiKey": linear_api_key}})


def get_settings():
    return read_store()["settings"]


def patch_settings(patch):
    current = read_store()
    return write_store({**current, "settings": {**current["settings"], **patch}})


def get_business_by_project_id(project_id):
    if not project_id:
        return None
    return next((b for b in read_store()["businesses"] if b.get("projectId") == project_id), None)


def get_github_token():
    return read_store()["settings"].get("githubToken") or ""


def set_github_token(github_token):
    return patch_settings({"githubToken": str(github_token or "")})


def get_repository_config():
    settings = read_store()["settings"]
    provider = "gitlab" if settings.get("repositoryProvider") == "gitlab" else "github"
    return {
        "provider": provider,
        "url": str(settings.get("repositoryUrl") or ""),
        "token": str((settings.get("gitlabToken") if provider == "gitlab" else settings.get("githubToken")) or ""),
    }


def get_repository_token(provider=None):
    if provider is None:
        return get_repository_config()["token"]
    settings = read_store()["settings"]
    if provider == "github":
        return str(settings.get("githubToken") or "")
    if provider == "gitlab":
        return str(settings.get("gitlabToken") or "")
    return ""


def get_planning_config():
    settings = read_store()["settings"]
    provider = settings.get("planningProvider") if settings.get("planningProvider") in ("linear", "jira", "asana") else "linear"
    if provider == "jira":
        return {
            "provider": provider,
            "baseUrl": str(settings.get("jiraBaseUrl") or ""),
            "email": str(settings.get("jiraEmail") or ""),
            "token": str(settings.get("jiraApiToken") or ""),
        }
    if provider == "asana":
        return {
            "provider": provider,
            "workspaceId": str(settings.get("asanaWorkspaceId") or ""),
            "token": str(settings.get("asanaAccessToken") or ""),
        }
    return {"provider": provider, "token": str(settings.get("linearApiKey") or "")}


# --------------------------- Codex OAuth tokens ------------------------- #


def get_codex_tokens():
    return read_store()["settings"].get("codexTokens") or None


def set_codex_tokens(tokens):
    return patch_settings({"codexTokens": tokens or None})


def clear_codex_tokens():
    return patch_settings({"codexTokens": None})


# --------------------------- Claude OAuth tokens ------------------------ #


def get_claude_tokens():
    return read_store()["settings"].get("claudeTokens") or None


def set_claude_tokens(tokens):
    return patch_settings({"claudeTokens": tokens or None})


def clear_claude_tokens():
    return patch_settings({"claudeTokens": None})


# --------------------------- Assumed role ------------------------------- #


def get_assumed_role():
    return read_store()["assumedRole"]


def set_assumed_role(role):
    current = read_store()
    return write_store({**current, "assumedRole": role or None})


# --------------------------- Agent config ------------------------------- #


def get_agent_config():
    return read_store()["agentConfig"]


def set_agent_config(patch):
    current = read_store()
    return write_store({**current, "agentConfig": {**current["agentConfig"], **patch}})


# --------------------------- Jobs --------------------------------------- #


def list_jobs(kind=None):
    jobs = read_store()["jobs"]
    if not kind:
        return jobs
    return [j for j in jobs if (j.get("kind") or "enrichment") == kind]


def add_job(job):
    current = read_store()
    return write_store({**current, "jobs": [job, *current["jobs"]]})


def update_job(id, patch):
    current = read_store()
    updated = None
    jobs = []
    for job in current["jobs"]:
        if job.get("id") != id:
            jobs.append(job)
        else:
            updated = {**job, **patch, "updatedAt": _iso_now()}
            jobs.append(updated)
    write_store({**current, "jobs": jobs})
    return updated


MAX_STEPS_PER_JOB = 100


def append_job_step(id, step):
    current = read_store()
    jobs = []
    for job in current["jobs"]:
        if job.get("id") != id:
            jobs.append(job)
        else:
            steps = [*(job.get("steps") or []), step][-MAX_STEPS_PER_JOB:]
            jobs.append({**job, "steps": steps, "updatedAt": _iso_now()})
    write_store({**current, "jobs": jobs})


def reconcile_running_jobs():
    current = read_store()
    count = 0
    jobs = []
    for job in current["jobs"]:
        if job.get("status") != "running":
            jobs.append(job)
            continue
        count += 1
        step = {"ts": _iso_now(), "level": "error", "message": "Interrupted by server restart."}
        jobs.append(
            {
                **job,
                "status": "error",
                "error": "Interrupted by server restart.",
                "finishedAt": _iso_now(),
                "steps": [*(job.get("steps") or []), step],
            }
        )
    if count:
        write_store({**current, "jobs": jobs})
    return count


def remove_job(id):
    current = read_store()
    jobs = [j for j in current["jobs"] if j.get("id") != id]
    removed = len(jobs) != len(current["jobs"])
    if removed:
        write_store({**current, "jobs": jobs})
    return removed


def clear_finished_jobs():
    current = read_store()
    jobs = [j for j in current["jobs"] if j.get("status") in ("pending", "running")]
    write_store({**current, "jobs": jobs})
    return jobs


def prune_jobs(keep=100):
    current = read_store()
    if len(current["jobs"]) <= keep:
        return current["jobs"]
    jobs = current["jobs"][:keep]
    write_store({**current, "jobs": jobs})
    return jobs


# --------------------------- Memories ----------------------------------- #

MAX_MEMORIES = 1000


def list_memories(filter=None):
    filter = filter or {}
    scope = filter.get("scope")
    ref_id = filter.get("refId")
    memories = read_store()["memories"]
    if scope:
        memories = [m for m in memories if m.get("scope") == scope]
    if ref_id:
        memories = [m for m in memories if m.get("refId") == ref_id]
    return memories


def add_memory(memory):
    current = read_store()
    now = _iso_now()
    record = {**memory, "id": f"mem_{_uuid()}", "createdAt": now, "updatedAt": now}
    memories = [record, *current["memories"]][:MAX_MEMORIES]
    write_store({**current, "memories": memories})
    return record


def remove_memory(id):
    current = read_store()
    memories = [m for m in current["memories"] if m.get("id") != id]
    removed = len(memories) != len(current["memories"])
    if removed:
        write_store({**current, "memories": memories})
    return removed


def prune_memories(keep=MAX_MEMORIES):
    current = read_store()
    if len(current["memories"]) <= keep:
        return current["memories"]
    memories = current["memories"][:keep]
    write_store({**current, "memories": memories})
    return memories


# --------------------------- Conversations ------------------------------ #

MAX_CONVERSATIONS = 100
MAX_MESSAGES_PER_CONVERSATION = 200


def list_conversations():
    return sorted(read_store()["conversations"], key=lambda c: str(c.get("updatedAt") or ""), reverse=True)


def get_conversation(id):
    return next((c for c in read_store()["conversations"] if c.get("id") == id), None)


def add_conversation(conversation=None):
    conversation = conversation or {}
    current = read_store()
    now = _iso_now()
    record = {
        "id": f"conv_{_uuid()}",
        "title": conversation.get("title") or "New conversation",
        "createdAt": now,
        "updatedAt": now,
        "messages": (conversation.get("messages") or [])[:MAX_MESSAGES_PER_CONVERSATION] if isinstance(conversation.get("messages"), list) else [],
    }
    conversations = [record, *current["conversations"]][:MAX_CONVERSATIONS]
    write_store({**current, "conversations": conversations})
    return record


def append_conversation_messages(id, messages):
    current = read_store()
    now = _iso_now()
    stamped = [{**m, "id": f"msg_{_uuid()}", "ts": now} for m in (messages if isinstance(messages, list) else [])]
    updated = None
    conversations = []
    for conversation in current["conversations"]:
        if conversation.get("id") != id:
            conversations.append(conversation)
        else:
            next_messages = [*(conversation.get("messages") or []), *stamped][-MAX_MESSAGES_PER_CONVERSATION:]
            updated = {**conversation, "messages": next_messages, "updatedAt": now}
            conversations.append(updated)
    if updated:
        write_store({**current, "conversations": conversations})
    return updated


def update_conversation(id, patch):
    current = read_store()
    updated = None
    conversations = []
    for conversation in current["conversations"]:
        if conversation.get("id") != id:
            conversations.append(conversation)
        else:
            updated = {**conversation, **patch, "id": conversation["id"], "updatedAt": _iso_now()}
            conversations.append(updated)
    if updated:
        write_store({**current, "conversations": conversations})
    return updated


def remove_conversation(id):
    current = read_store()
    conversations = [c for c in current["conversations"] if c.get("id") != id]
    removed = len(conversations) != len(current["conversations"])
    if removed:
        write_store({**current, "conversations": conversations})
    return removed


def prune_conversations(keep=MAX_CONVERSATIONS):
    current = read_store()
    if len(current["conversations"]) <= keep:
        return current["conversations"]
    conversations = current["conversations"][:keep]
    write_store({**current, "conversations": conversations})
    return conversations


# --------------------- Requirement approval gates ----------------------- #

MAX_APPROVAL_GATES = 200


def list_approval_gates(filter=None):
    filter = filter or {}
    all_gates = sorted(read_store()["approvals"], key=lambda g: str(g.get("createdAt") or ""), reverse=True)
    result = []
    for gate in all_gates:
        if filter.get("status") and gate.get("status") != filter["status"]:
            continue
        if filter.get("businessId") and gate.get("businessId") != filter["businessId"]:
            continue
        result.append(gate)
    return result


def get_approval_gate(id):
    return next((g for g in read_store()["approvals"] if g.get("id") == id), None)


def add_approval_gate(gate=None):
    gate = gate or {}
    current = read_store()
    now = _iso_now()
    record = {**gate, "id": f"gate_{_uuid()}", "createdAt": now, "updatedAt": now}
    approvals = [record, *current["approvals"]][:MAX_APPROVAL_GATES]
    write_store({**current, "approvals": approvals})
    return record


def update_approval_gate(id, patch):
    current = read_store()
    updated = None
    approvals = []
    for gate in current["approvals"]:
        if gate.get("id") != id:
            approvals.append(gate)
        else:
            updated = {**gate, **patch, "id": gate["id"], "createdAt": gate["createdAt"], "updatedAt": _iso_now()}
            approvals.append(updated)
    if updated:
        write_store({**current, "approvals": approvals})
    return updated


def remove_approval_gate(id):
    current = read_store()
    approvals = [g for g in current["approvals"] if g.get("id") != id]
    removed = len(approvals) != len(current["approvals"])
    if removed:
        write_store({**current, "approvals": approvals})
    return removed


def prune_approval_gates(keep=MAX_APPROVAL_GATES):
    current = read_store()
    if len(current["approvals"]) <= keep:
        return current["approvals"]
    approvals = sorted(current["approvals"], key=lambda g: str(g.get("createdAt") or ""), reverse=True)[:keep]
    write_store({**current, "approvals": approvals})
    return approvals
