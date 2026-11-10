"""HTTP API stub. Auth via APP_TOKEN in #t= fragment / localStorage later."""
from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(title="desk", docs_url=None, redoc_url=None)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "step": 3}
