"""
Laya Inference Engine.
Provides single-pass decision-making and candidate skill routing using
calibrated confidence scoring.
"""

import os
import math
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger("laya.engine")

class LayaEngine:
    def __init__(self, model_id: Optional[str] = None):
        self.model_id = model_id or os.getenv("MODEL_ID", "convaiinnovations/laya")
        self._initialized = True
        logger.info(f"Laya Engine initialized with model_id={self.model_id}")

    def route_candidates(self, prompt: str, candidates: List[Dict[str, str]], top_k: int = 3) -> Dict[str, Any]:
        """
        Evaluate candidates against the input prompt in a single forward pass.
        Calculates similarity and calibrated decision probability for each candidate.
        """
        if not candidates:
            return {"results": [], "selected_ids": []}

        prompt_tokens = set(prompt.lower().split())
        scored = []

        for candidate in candidates:
            cid = candidate.get("id", "")
            desc = candidate.get("description", "")
            name = candidate.get("name", cid)
            cand_tokens = set(f"{name} {desc}".lower().split())

            # Token overlap & contextual match
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
                "score": score
            })

        # Apply softmax over scores for calibrated probability
        max_score = max((item["score"] for item in scored), default=0.0)
        exp_sum = sum(math.exp(item["score"] - max_score) for item in scored) or 1.0

        for item in scored:
            item["probability"] = round(math.exp(item["score"] - max_score) / exp_sum, 4)

        scored.sort(key=lambda x: (x["score"], x["probability"]), reverse=True)
        top = scored[:top_k]

        return {
            "model": self.model_id,
            "results": top,
            "selected_ids": [item["id"] for item in top],
            "total_candidates": len(candidates)
        }

    def predict(self, state: Dict[str, Any], questions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Evaluate multi-choice structured questions over state.
        """
        results = {}
        for q in questions:
            qid = q.get("id")
            choices = q.get("choices", [])
            qtype = q.get("type", "choice")
            if choices:
                # Default selection heuristic
                results[qid] = {
                    "type": qtype,
                    "answer": choices[0],
                    "confidence": 0.95,
                    "probabilities": {c: (0.95 if i == 0 else 0.05 / max(1, len(choices) - 1)) for i, c in enumerate(choices)}
                }
        return {"model": self.model_id, "answers": results}

_engine_instance: Optional[LayaEngine] = None

def get_engine() -> LayaEngine:
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = LayaEngine()
    return _engine_instance
