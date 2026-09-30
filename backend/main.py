from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import store

app = FastAPI(title="Perim — Edge Memory & Intelligence API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


class MemoryIn(BaseModel):
    text: str
    device_id: str = "device-1"
    source: str = "manual"
    force_tag: Optional[str] = None


class ResolveIn(BaseModel):
    keep: str  # "device" | "cloud" | "newest"


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/status")
def get_status():
    return store.status()


@app.post("/api/memory")
def create_memory(body: MemoryIn):
    return store.add_memory(body.text, body.device_id, body.source, body.force_tag)


@app.get("/api/memory")
def get_memory():
    return store.list_memory()


@app.delete("/api/memory/{item_id}")
def remove_memory(item_id: str):
    store.delete_memory(item_id)
    return {"ok": True}


@app.get("/api/search")
def search(q: str):
    if not q.strip():
        return []
    return store.search_memory(q)


@app.post("/api/sync")
def sync():
    return store.sync_pending()


@app.post("/api/memory/{item_id}/simulate-remote-edit")
def simulate_remote_edit(item_id: str):
    result = store.simulate_remote_edit(item_id)
    if not result.get("ok"):
        raise HTTPException(404, "item not found in cloud (must be synced first)")
    store.sync_pending()
    return result


@app.post("/api/memory/{item_id}/resolve")
def resolve(item_id: str, body: ResolveIn):
    result = store.resolve_conflict(item_id, body.keep)
    if not result.get("ok"):
        raise HTTPException(404, "item not found")
    store.sync_pending()
    return result


@app.get("/api/cloud")
def cloud():
    return store.cloud_snapshot()


@app.get("/api/activity")
def activity(limit: int = 200):
    return store.get_log(limit)


# ---- serve the frontend (single-page app) ----
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="assets")


@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))
