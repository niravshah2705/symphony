"""
CLM Contrastive Inference Service.
Cloud Run v2 entrypoint providing dual-encoder contrastive skill routing and embedding computation.
"""

from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from app.engine import get_clm_engine

app = FastAPI(title="CLM Contrastive Inference Service", version="1.0.0")

class CandidateItem(BaseModel):
    id: str
    name: Optional[str] = None
    description: str

class RouteRequest(BaseModel):
    query: str
    candidates: List[CandidateItem]
    top_k: int = 3

class EmbedRequest(BaseModel):
    texts: List[str]

@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "clm-inference"}

@app.post("/route")
def route(req: RouteRequest):
    engine = get_clm_engine()
    return engine.route_candidates(
        query=req.query,
        candidates=[c.model_dump() for c in req.candidates],
        top_k=req.top_k
    )

@app.post("/embed")
def embed(req: EmbedRequest):
    engine = get_clm_engine()
    return {"embeddings": engine.embed_texts(req.texts)}
