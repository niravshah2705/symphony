"""Bounded lexical search over reviewed workspace documentation (port of
agent/knowledge-search.js).

Security-critical constraints (preserved exactly from the JS): only README.md +
docs/ are indexed, symlinks are refused, resolved paths must stay inside the
root (no escape via ``..``/links), only a small allow-list of extensions is read,
and hard caps bound the number/size of files scanned and the walk depth.
"""

from __future__ import annotations

import os
import re
import stat as stat_mod
from pathlib import Path

# The JS resolves 4 levels up from __dirname (packages/shared/src/agent) = repo
# root. Here the module lives at ai_fleet/agent/knowledge_search.py, so parents[2]
# (agent -> ai_fleet -> repo root) is the repo root.
DEFAULT_ROOT = str(Path(__file__).resolve().parents[2])
MAX_QUERY_CHARS = 8_000
MAX_FILES = 80
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
MAX_RESULTS = 8
ALLOWED_EXTENSIONS = frozenset({".md", ".mdx", ".txt"})
STOP_WORDS = frozenset({
    "about", "after", "also", "and", "are", "can", "check", "find", "for", "from", "have",
    "into", "look", "our", "please", "search", "show", "that", "the", "their", "this", "what",
    "when", "where", "which", "with", "workspace", "would", "your",
})

_WS_RE = re.compile(r"\s+")
_TERM_RE = re.compile(r"[a-z0-9][a-z0-9_-]{1,}")
_HEADING_RE = re.compile(r"^#{1,3}\s+\S")
_HEADING_STRIP_RE = re.compile(r"^#{1,3}\s+")
_HEADING_STRIP6_RE = re.compile(r"^#{1,6}\s+")
_NEWLINE_RE = re.compile(r"\r?\n")


class KnowledgeSearchError(Exception):
    def __init__(self, message, status: int = 400):
        super().__init__(message)
        self.name = "KnowledgeSearchError"
        self.message = message
        self.status = status


def normalize_query(value):
    if not isinstance(value, str):
        raise KnowledgeSearchError("query must be a string.")
    query = _WS_RE.sub(" ", value).strip()
    if not query:
        raise KnowledgeSearchError("Describe what you want to find.")
    if len(query) > MAX_QUERY_CHARS:
        raise KnowledgeSearchError(f"query must be {MAX_QUERY_CHARS:,} characters or fewer.")
    return query


def query_terms(query):
    # [...new Set(...)] dedupes preserving first-seen order.
    unique = list(dict.fromkeys(_TERM_RE.findall(query.lower())))
    return [term for term in unique if len(term) > 2 and term not in STOP_WORDS][:20]


def collect_document_paths(root):
    resolved_root = str(Path(root).resolve())
    files: list[dict] = []

    def add_file(candidate: str) -> None:
        if len(files) >= MAX_FILES:
            return
        try:
            st = os.lstat(candidate)
        except OSError:
            return
        is_file = stat_mod.S_ISREG(st.st_mode)
        is_symlink = stat_mod.S_ISLNK(st.st_mode)
        if (not is_file) or is_symlink or st.st_size > MAX_FILE_BYTES:
            return
        if Path(candidate).suffix.lower() not in ALLOWED_EXTENSIONS:
            return
        resolved = str(Path(candidate).resolve())
        if resolved != resolved_root and not resolved.startswith(f"{resolved_root}{os.sep}"):
            return
        files.append({
            "absolute": resolved,
            "relative": os.path.relpath(resolved, resolved_root),
            "size": st.st_size,
        })

    add_file(os.path.join(resolved_root, "README.md"))

    def walk(directory: str, depth: int) -> None:
        if depth > 3 or len(files) >= MAX_FILES:
            return
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if len(files) >= MAX_FILES:
                break
            if entry.is_symlink():
                continue
            candidate = os.path.join(directory, entry.name)
            if entry.is_dir(follow_symlinks=False):
                walk(candidate, depth + 1)
            elif entry.is_file(follow_symlinks=False):
                add_file(candidate)

    walk(os.path.join(resolved_root, "docs"), 0)
    return files


def document_title(lines, relative):
    heading = next((line for line in lines if _HEADING_RE.match(line)), None)
    if heading:
        return _HEADING_STRIP_RE.sub("", heading).strip()[:160]
    return Path(relative).stem


def clean_snippet(lines, index):
    segment = lines[max(0, index - 1): min(len(lines), index + 2)]
    cleaned = []
    for line in segment:
        text = _HEADING_STRIP6_RE.sub("", line)
        text = _WS_RE.sub(" ", text).strip()
        if text:
            cleaned.append(text)
    return " ".join(cleaned)[:520]


def score_line(line, terms, phrase):
    lower = line.lower()
    term_score = sum(2 for term in terms if term in lower)
    phrase_score = 5 if len(phrase) >= 5 and phrase in lower else 0
    return term_score + phrase_score


def _to_number(value):
    # Mirror JS Number(x): non-numeric -> NaN, which is falsy in `x || default`.
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:  # NaN
        return None
    return n


def search_documents(value, options=None):
    """Bounded lexical search over reviewed workspace documentation only."""
    options = options or {}
    query = normalize_query(value)
    terms = query_terms(query)
    if not terms:
        return {"query": query, "indexedFiles": 0, "results": []}
    paths = collect_document_paths(options.get("root") or DEFAULT_ROOT)
    phrase = query.lower()
    total_bytes = 0
    matches = []
    for file in paths:
        if total_bytes + file["size"] > MAX_TOTAL_BYTES:
            break
        total_bytes += file["size"]
        try:
            with open(file["absolute"], "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except Exception:  # noqa: BLE001 — JS `catch (_) { continue; }`
            continue
        lines = _NEWLINE_RE.split(text)
        best = None
        for index, line in enumerate(lines):
            score = score_line(line, terms, phrase)
            if score > 0 and (best is None or score > best["score"]):
                best = {"score": score, "index": index}
        if best is None:
            continue
        matches.append({
            "type": "Workspace document",
            "title": document_title(lines, file["relative"]),
            "path": file["relative"].replace(os.sep, "/"),
            "snippet": clean_snippet(lines, best["index"]),
            "score": best["score"],
        })
    raw_limit = _to_number(options.get("limit")) or MAX_RESULTS
    limit = int(min(MAX_RESULTS, max(1, raw_limit)))
    ordered = sorted(matches, key=lambda m: (-m["score"], m["path"]))
    return {"query": query, "indexedFiles": len(paths), "results": ordered[:limit]}
