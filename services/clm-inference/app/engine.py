"""
CLM (Contrastive Language Model) Inference Engine.

Embeds the query and candidate skills with the hosted EmbeddingGemma backend
(vLLM/Ollama over the OpenAI-compatible API) and ranks by cosine similarity.
When no backend is configured — or the call fails/times out — it falls back to
a deterministic local feature embedding so routing always returns.
"""

import hashlib
import logging
import math
import os
from typing import Dict, List, Any, Optional

from app.inference_client import InferenceClient, InferenceConfig

logger = logging.getLogger("clm.engine")


class CLMEngine:
    def __init__(
        self,
        model_id: Optional[str] = None,
        client: Optional[InferenceClient] = None,
    ):
        self.client = client or InferenceClient(InferenceConfig.from_env())
        self.model_id = model_id or os.getenv("MODEL_ID") or (
            self.client.config.model if self.client.configured else "convaiinnovations/clm-contrastive"
        )
        self._embedding_cache: Dict[str, List[float]] = {}
        self._cache_kind: Optional[str] = None
        logger.info(
            "CLM Engine initialized (model_id=%s, backend=%s)",
            self.model_id,
            self.client.config.base_url or "local-fallback",
        )

    # -- embeddings ----------------------------------------------------------

    def _pseudo_embed(self, text: str, dim: int = 64) -> List[float]:
        """Deterministic local feature vector used only when the backend is unavailable."""
        words = text.lower().split()
        vec = [0.0] * dim
        for w in words:
            h = int(hashlib.md5(w.encode("utf-8")).hexdigest(), 16)
            for i in range(dim):
                bit = (h >> (i % 32)) & 1
                vec[i] += (1.0 if bit else -0.5)

        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [round(x / norm, 4) for x in vec]

    def _set_cache_kind(self, kind: str) -> None:
        # Never mix model vectors (e.g. 768-dim) with local 64-dim vectors.
        if self._cache_kind != kind:
            self._embedding_cache.clear()
            self._cache_kind = kind

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        if self.client.configured:
            try:
                return self._model_embeddings(texts)
            except Exception as exc:  # noqa: BLE001 - fallback is the contract
                logger.warning("CLM embedding backend failed, using local fallback: %s", exc)

        self._set_cache_kind("pseudo")
        for text in texts:
            if text not in self._embedding_cache:
                self._embedding_cache[text] = self._pseudo_embed(text)
        return [self._embedding_cache[text] for text in texts]

    def _model_embeddings(self, texts: List[str]) -> List[List[float]]:
        self._set_cache_kind("model")
        missing = [t for t in dict.fromkeys(texts) if t not in self._embedding_cache]
        if missing:
            vectors = self.client.embed(missing)
            if len(vectors) != len(missing):
                raise ValueError(
                    f"embedding backend returned {len(vectors)} vectors for {len(missing)} inputs"
                )
            for text, vector in zip(missing, vectors):
                self._embedding_cache[text] = vector
        return [self._embedding_cache[text] for text in texts]

    # -- routing -------------------------------------------------------------

    def route_candidates(self, query: str, candidates: List[Dict[str, str]], top_k: int = 3) -> Dict[str, Any]:
        """Contrastive matching between the query and cached candidate embeddings."""
        if not candidates:
            return {"results": [], "selected_ids": []}

        cand_texts = [f"{c.get('name') or c.get('id')}: {c.get('description', '')}" for c in candidates]
        vectors = self.embed_texts([query, *cand_texts])
        query_vec, cand_vecs = vectors[0], vectors[1:]

        scored = []
        for candidate, cand_vec in zip(candidates, cand_vecs):
            cid = candidate.get("id", "")
            name = candidate.get("name", cid)
            desc = candidate.get("description", "")

            sim = _cosine(query_vec, cand_vec)
            sim = max(0.0, min(1.0, (sim + 1.0) / 2.0))  # map cosine to 0..1

            scored.append({
                "id": cid,
                "name": name,
                "description": desc,
                "similarity": round(sim, 4),
            })

        scored.sort(key=lambda x: x["similarity"], reverse=True)
        top = scored[:top_k]

        return {
            "model": self.model_id,
            "source": self._cache_kind or "local",
            "results": top,
            "selected_ids": [item["id"] for item in top],
            "total_candidates": len(candidates),
            "cached_embeddings_count": len(self._embedding_cache),
        }


def _cosine(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


_clm_engine: Optional[CLMEngine] = None


def get_clm_engine() -> CLMEngine:
    global _clm_engine
    if _clm_engine is None:
        _clm_engine = CLMEngine()
    return _clm_engine
