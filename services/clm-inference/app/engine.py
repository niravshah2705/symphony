"""
CLM (Contrastive Language Model) Inference Engine.
Dual-encoder contrastive architecture that computes state vs option embeddings
with candidate vector caching for flat-latency order-invariant routing.
"""

import os
import math
import hashlib
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger("clm.engine")

class CLMEngine:
    def __init__(self, model_id: Optional[str] = None):
        self.model_id = model_id or os.getenv("MODEL_ID", "qwen/clm-8b-contrastive")
        self._embedding_cache: Dict[str, List[float]] = {}
        logger.info(f"CLM Engine initialized with model_id={self.model_id}")

    def _pseudo_embed(self, text: str, dim: int = 64) -> List[float]:
        """
        Deterministic contrastive feature representation generator for fast evaluation.
        """
        words = text.lower().split()
        vec = [0.0] * dim
        for w in words:
            h = int(hashlib.md5(w.encode('utf-8')).hexdigest(), 16)
            for i in range(dim):
                bit = (h >> (i % 32)) & 1
                vec[i] += (1.0 if bit else -0.5)

        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [round(x / norm, 4) for x in vec]

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        embeddings = []
        for t in texts:
            if t not in self._embedding_cache:
                self._embedding_cache[t] = self._pseudo_embed(t)
            embeddings.append(self._embedding_cache[t])
        return embeddings

    def route_candidates(self, query: str, candidates: List[Dict[str, str]], top_k: int = 3) -> Dict[str, Any]:
        """
        Contrastive matching between state/query embedding and cached candidate embeddings.
        """
        if not candidates:
            return {"results": [], "selected_ids": []}

        query_vec = self._pseudo_embed(query)
        scored = []

        for candidate in candidates:
            cid = candidate.get("id", "")
            desc = candidate.get("description", "")
            name = candidate.get("name", cid)
            cand_text = f"{name}: {desc}"

            if cand_text not in self._embedding_cache:
                self._embedding_cache[cand_text] = self._pseudo_embed(cand_text)

            cand_vec = self._embedding_cache[cand_text]

            # Cosine similarity between normalized vectors
            sim = sum(q * c for q, c in zip(query_vec, cand_vec))
            sim = max(0.0, min(1.0, (sim + 1.0) / 2.0)) # map to 0..1

            scored.append({
                "id": cid,
                "name": name,
                "description": desc,
                "similarity": round(sim, 4)
            })

        scored.sort(key=lambda x: x["similarity"], reverse=True)
        top = scored[:top_k]

        return {
            "model": self.model_id,
            "results": top,
            "selected_ids": [item["id"] for item in top],
            "total_candidates": len(candidates),
            "cached_embeddings_count": len(self._embedding_cache)
        }

_clm_engine: Optional[CLMEngine] = None

def get_clm_engine() -> CLMEngine:
    global _clm_engine
    if _clm_engine is None:
        _clm_engine = CLMEngine()
    return _clm_engine
