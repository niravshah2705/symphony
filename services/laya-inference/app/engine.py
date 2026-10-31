"""
Laya Inference Engine.

Routes skill candidates and answers structured decisions using the hosted
Gemma backend (vLLM/Ollama over the OpenAI-compatible API). When no backend is
configured — or the call fails/times out — it falls back to a deterministic
in-process lexical scorer so callers always get a bounded-latency answer.
"""

import json
import logging
import math
import os
from typing import Any, Dict, List, Optional

from app.inference_client import InferenceClient, InferenceConfig

logger = logging.getLogger("laya.engine")


class LayaEngine:
    def __init__(
        self,
        model_id: Optional[str] = None,
        client: Optional[InferenceClient] = None,
    ):
        self.client = client or InferenceClient(InferenceConfig.from_env())
        self.model_id = model_id or os.getenv("MODEL_ID") or (
            self.client.config.model if self.client.configured else "convaiinnovations/laya"
        )
        logger.info(
            "Laya Engine initialized (model_id=%s, backend=%s)",
            self.model_id,
            self.client.config.base_url or "in-process-fallback",
        )

    # -- routing -------------------------------------------------------------

    def route_candidates(self, prompt: str, candidates: List[Dict[str, str]], top_k: int = 3) -> Dict[str, Any]:
        """Rank candidate skills for a prompt, model-first with lexical fallback."""
        if not candidates:
            return {"results": [], "selected_ids": []}

        if self.client.configured:
            try:
                selected = self._model_route(prompt, candidates, top_k)
                if selected:
                    return self._response(selected, candidates, source="model")
            except Exception as exc:  # noqa: BLE001 - fallback is the contract
                logger.warning("Laya model routing failed, using lexical fallback: %s", exc)

        return self._heuristic_route(prompt, candidates, top_k)

    def _model_route(self, prompt: str, candidates: List[Dict[str, str]], top_k: int) -> List[str]:
        catalogue = "\n".join(
            f"- {c.get('id')}: {c.get('name') or c.get('id')} — {c.get('description', '')}"
            for c in candidates
        )
        content = self.client.chat([
            {
                "role": "system",
                "content": (
                    "You are a skill router. Select the skill ids that best match "
                    "the request. Respond with ONLY a JSON object of the form "
                    '{"selected_ids": ["id", ...]}. Never invent ids.'
                ),
            },
            {
                "role": "user",
                "content": f"Request:\n{prompt}\n\nCandidates:\n{catalogue}\n\nReturn at most {top_k} ids.",
            },
        ])
        payload = _extract_json(content) or {}
        raw = payload.get("selected_ids", [])
        allowed = {c.get("id") for c in candidates}
        return [str(i) for i in raw if str(i) in allowed][:top_k]

    def _heuristic_route(self, prompt: str, candidates: List[Dict[str, str]], top_k: int) -> Dict[str, Any]:
        prompt_tokens = set(prompt.lower().split())
        scored = []

        for candidate in candidates:
            cid = candidate.get("id", "")
            desc = candidate.get("description", "")
            name = candidate.get("name", cid)
            cand_tokens = set(f"{name} {desc}".lower().split())

            intersection = prompt_tokens.intersection(cand_tokens)
            score = 0.0
            if cand_tokens:
                jaccard = len(intersection) / len(cand_tokens)
                exact_name_boost = 1.0 if name.lower() in prompt.lower() else 0.0
                raw_score = (jaccard * 0.7) + (exact_name_boost * 0.3)
                score = round(raw_score, 4)

            scored.append({
                "id": cid,
                "name": name,
                "description": desc,
                "score": score,
            })

        max_score = max((item["score"] for item in scored), default=0.0)
        exp_sum = sum(math.exp(item["score"] - max_score) for item in scored) or 1.0

        for item in scored:
            item["probability"] = round(math.exp(item["score"] - max_score) / exp_sum, 4)

        scored.sort(key=lambda x: (x["score"], x["probability"]), reverse=True)
        top = scored[:top_k]

        return {
            "model": self.model_id,
            "source": "heuristic",
            "results": top,
            "selected_ids": [item["id"] for item in top],
            "total_candidates": len(candidates),
        }

    def _response(self, selected_ids: List[str], candidates: List[Dict[str, str]], source: str) -> Dict[str, Any]:
        by_id = {c.get("id"): c for c in candidates}
        results = [
            {
                "id": cid,
                "name": by_id[cid].get("name") or cid,
                "description": by_id[cid].get("description", ""),
                "score": 1.0,
                "probability": 1.0,
            }
            for cid in selected_ids
            if cid in by_id
        ]
        return {
            "model": self.model_id,
            "source": source,
            "results": results,
            "selected_ids": [item["id"] for item in results],
            "total_candidates": len(candidates),
        }

    # -- structured prediction ----------------------------------------------

    def predict(self, state: Dict[str, Any], questions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Answer multi-choice questions over state, model-first with fallback."""
        if not questions:
            return {"model": self.model_id, "answers": {}}

        if self.client.configured:
            try:
                answers = self._model_predict(state, questions)
                if answers:
                    # Fill questions the model skipped with the deterministic answer.
                    fallback = self._heuristic_predict(state, questions)["answers"]
                    return {"model": self.model_id, "source": "model", "answers": {**fallback, **answers}}
            except Exception as exc:  # noqa: BLE001 - fallback is the contract
                logger.warning("Laya model prediction failed, using fallback: %s", exc)

        return self._heuristic_predict(state, questions)

    def _model_predict(self, state: Dict[str, Any], questions: List[Dict[str, Any]]) -> Dict[str, Any]:
        spec = [
            {"id": q.get("id"), "type": q.get("type", "choice"), "choices": q.get("choices", [])}
            for q in questions
        ]
        content = self.client.chat([
            {
                "role": "system",
                "content": (
                    "You answer structured multiple-choice questions about a "
                    "software state. Respond with ONLY a JSON object "
                    '{"answers": {"<question-id>": "<exact choice>"}}.'
                ),
            },
            {
                "role": "user",
                "content": f"State:\n{json.dumps(state)}\n\nQuestions:\n{json.dumps(spec)}",
            },
        ])
        payload = _extract_json(content) or {}
        raw = payload.get("answers", {})
        if not isinstance(raw, dict):
            return {}

        answers: Dict[str, Any] = {}
        for question in questions:
            qid = question.get("id")
            choices = question.get("choices", [])
            choice = raw.get(qid)
            if qid and choice in choices:
                answers[qid] = {
                    "type": question.get("type", "choice"),
                    "answer": choice,
                    "confidence": 1.0,
                    "probabilities": {c: (1.0 if c == choice else 0.0) for c in choices},
                }
        return answers

    def _heuristic_predict(self, state: Dict[str, Any], questions: List[Dict[str, Any]]) -> Dict[str, Any]:
        results = {}
        for q in questions:
            qid = q.get("id")
            choices = q.get("choices", [])
            qtype = q.get("type", "choice")
            if choices:
                results[qid] = {
                    "type": qtype,
                    "answer": choices[0],
                    "confidence": 0.95,
                    "probabilities": {
                        c: (0.95 if i == 0 else 0.05 / max(1, len(choices) - 1))
                        for i, c in enumerate(choices)
                    },
                }
        return {"model": self.model_id, "source": "heuristic", "answers": results}


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first JSON object out of a model response (handles code fences)."""
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


_engine_instance: Optional[LayaEngine] = None


def get_engine() -> LayaEngine:
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = LayaEngine()
    return _engine_instance
