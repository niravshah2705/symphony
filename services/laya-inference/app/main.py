"""
Laya Inference Service.
Cloud Run v2 entrypoint providing internal System 1 decision-making and skill routing.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from app.engine import get_engine

app = FastAPI(title="Laya Inference Service", version="1.0.0")

class ChoiceQuestion(BaseModel):
    id: str
    type: str = "choice"
    choices: List[str]

class PredictRequest(BaseModel):
    state: Dict[str, Any]
    questions: List[ChoiceQuestion]

class Candidate(BaseModel):
    id: str
    name: Optional[str] = None
    description: str

class RouteRequest(BaseModel):
    prompt: str
    candidates: List[Candidate]
    top_k: int = 3

@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "laya-inference"}

@app.post("/predict")
def predict(req: PredictRequest):
    engine = get_engine()
    return engine.predict(req.state, [q.model_dump() for q in req.questions])

@app.post("/route")
def route(req: RouteRequest):
    engine = get_engine()
    return engine.route_candidates(
        prompt=req.prompt,
        candidates=[c.model_dump() for c in req.candidates],
        top_k=req.top_k
    )
