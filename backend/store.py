"""
Perim backend — storage, embedding and sync-policy layer.

Two REAL Qdrant collections are used (via the embedded/local Qdrant engine,
which needs no server process — this is what "Qdrant Edge" means in
practice: the vector engine runs in-process, on-device):

  - edge_memory  : this device's local memory (source of truth for the device)
  - cloud_memory : the central store items get pushed to once they're
                   sync-eligible and connectivity is up. Point CLOUD_URL at a
                   real remote Qdrant Server (Qdrant Cloud, or a self-hosted
                   instance) to go from "simulated cloud" to a real one —
                   nothing else in this file has to change.
"""
import os
import time
import uuid
import sqlite3
import hashlib
from pathlib import Path
from typing import Optional

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, PointIdsList

DATA_DIR = Path(os.environ.get("PERIM_DATA_DIR", Path(__file__).parent.parent / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

EDGE_PATH = str(DATA_DIR / "edge_qdrant")
CLOUD_URL = os.environ.get("PERIM_CLOUD_URL")          # set this to a real Qdrant Server to go live
CLOUD_PATH = str(DATA_DIR / "cloud_qdrant")            # used when CLOUD_URL is not set (simulated cloud)
LOG_DB = str(DATA_DIR / "activity_log.sqlite3")

VECTOR_SIZE = 64
EDGE_COLLECTION = "edge_memory"
CLOUD_COLLECTION = "cloud_memory"

SENSITIVE_TERMS = ["password", "otp", "aadhaar", "pin", "secret", "card number", "key", "credential"]

# ---------------------------------------------------------------- embedding
# Deterministic, offline, dependency-free embedding (hashed bag-of-words +
# character n-grams). It needs no model download and no network call, which
# matters on a genuine edge device. Swap in a real sentence-embedding model
# (e.g. fastembed / sentence-transformers) here for production — nothing
# else in the file depends on how the vector is produced, only on its size.
def embed(text: str) -> list[float]:
    vec = [0.0] * VECTOR_SIZE
    words = "".join(c if c.isalnum() else " " for c in text.lower()).split()
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        vec[h % VECTOR_SIZE] += 1.0
        for n in (3, 4):
            for i in range(max(0, len(w) - n + 1)):
                gram = w[i:i + n]
                h2 = int(hashlib.md5(gram.encode()).hexdigest(), 16)
                vec[h2 % VECTOR_SIZE] += 0.4
    norm = sum(v * v for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


import re as _re
_SENSITIVE_PATTERNS = [_re.compile(r"\b" + _re.escape(t) + r"\b") for t in SENSITIVE_TERMS]


def classify(text: str) -> str:
    """Sync-policy rule engine — decides device-only vs sync-eligible at write time.
    Matches whole words/phrases only, so "dropping" doesn't trip the "pin" rule."""
    low = text.lower()
    return "local" if any(p.search(low) for p in _SENSITIVE_PATTERNS) else "sync"


# ---------------------------------------------------------------- qdrant
_edge = QdrantClient(path=EDGE_PATH)
_cloud = QdrantClient(url=CLOUD_URL) if CLOUD_URL else QdrantClient(path=CLOUD_PATH)
CLOUD_MODE = "remote" if CLOUD_URL else "simulated"


def _ensure(client: QdrantClient, name: str):
    if not client.collection_exists(name):
        client.create_collection(name, vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE))


_ensure(_edge, EDGE_COLLECTION)
try:
    _ensure(_cloud, CLOUD_COLLECTION)
    CLOUD_REACHABLE_AT_BOOT = True
except Exception:
    CLOUD_REACHABLE_AT_BOOT = False


def cloud_reachable() -> bool:
    try:
        _cloud.get_collections()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- activity log (sqlite)
_conn = sqlite3.connect(LOG_DB, check_same_thread=False)
_conn.execute("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT, text TEXT)")
_conn.commit()


def log_event(kind: str, text: str):
    _conn.execute("INSERT INTO log (ts, kind, text) VALUES (?, ?, ?)", (time.time(), kind, text))
    _conn.commit()


def get_log(limit: int = 200):
    rows = _conn.execute("SELECT ts, kind, text FROM log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"ts": r[0], "kind": r[1], "text": r[2]} for r in rows]


# ---------------------------------------------------------------- memory ops
def add_memory(text: str, device_id: str, source: str = "manual", force_tag: Optional[str] = None) -> dict:
    now = time.time()
    tag = force_tag or classify(text)
    point_id = str(uuid.uuid4())
    payload = {
        "text": text, "tag": tag, "sync_status": "unsynced",
        "device_id": device_id, "source": source,
        "created_at": now, "updated_at": now,
    }
    _edge.upsert(EDGE_COLLECTION, points=[PointStruct(id=point_id, vector=embed(text), payload=payload)])
    log_event("created", f"{'Local-only' if tag=='local' else 'Sync-eligible'} memory saved ({source})")
    return {"id": point_id, **payload}


def list_memory(limit: int = 200) -> list[dict]:
    points, _ = _edge.scroll(EDGE_COLLECTION, limit=limit, with_payload=True)
    items = [{"id": p.id, **p.payload} for p in points]
    return sorted(items, key=lambda x: x["updated_at"], reverse=True)


def delete_memory(item_id: str):
    _edge.delete(EDGE_COLLECTION, points_selector=PointIdsList(points=[item_id]))
    log_event("created", "Memory item deleted")


def search_memory(query: str, top_k: int = 8) -> list[dict]:
    qv = embed(query)
    result = _edge.query_points(EDGE_COLLECTION, query=qv, limit=top_k, score_threshold=0.05, with_payload=True)
    log_event("search", f'Searched device memory: "{query}"')
    return [{"id": h.id, "score": h.score, **h.payload} for h in result.points]


def sync_pending(device_id: Optional[str] = None) -> dict:
    """Push sync-eligible, unsynced items to the cloud collection, and reconcile
    already-synced items against their cloud copy to catch remote-side edits."""
    if not cloud_reachable():
        return {"synced": 0, "reason": "cloud_unreachable", "cloud_mode": CLOUD_MODE}
    points, _ = _edge.scroll(EDGE_COLLECTION, limit=500, with_payload=True, with_vectors=True)

    pending = [p for p in points if p.payload["tag"] == "sync" and p.payload["sync_status"] != "synced"
               and not p.payload.get("conflict")]
    already_synced = [p for p in points if p.payload["tag"] == "sync" and p.payload["sync_status"] == "synced"
                       and not p.payload.get("conflict")]

    conflicts = []
    pushed = 0

    # 1) reconcile items we believe are already synced, in case the cloud copy moved
    for p in already_synced:
        try:
            found = _cloud.retrieve(CLOUD_COLLECTION, ids=[p.id], with_payload=True)
        except Exception:
            found = None
        if not found:
            continue
        cloud_text = found[0].payload.get("text")
        last_known = p.payload.get("_last_known_cloud_text", p.payload["text"])
        if cloud_text != p.payload["text"] and cloud_text != last_known:
            _edge.set_payload(EDGE_COLLECTION, payload={
                "conflict": True, "cloud_text": cloud_text,
                "cloud_time": found[0].payload.get("updated_at"),
            }, points=[p.id])
            conflicts.append(p.id)
            log_event("conflict", "Conflict detected: item changed at base since last sync")

    # 2) push whatever is newly pending
    for p in pending:
        cloud_payload = dict(p.payload)
        cloud_payload["_last_pushed_at"] = time.time()
        _cloud.upsert(CLOUD_COLLECTION, points=[PointStruct(id=p.id, vector=p.vector or embed(p.payload["text"]), payload=cloud_payload)])
        _edge.set_payload(EDGE_COLLECTION, payload={"sync_status": "synced", "_last_known_cloud_text": p.payload["text"]}, points=[p.id])
        pushed += 1

    if pushed:
        log_event("synced", f"Pushed {pushed} item(s) to Qdrant Server ({CLOUD_MODE})")
    return {"synced": pushed, "conflicts": conflicts, "cloud_mode": CLOUD_MODE}


def simulate_remote_edit(item_id: str) -> dict:
    """Demo-only helper: mutates the CLOUD copy of an already-synced item, as if
    someone else had edited it centrally, so the next sync surfaces a real conflict."""
    found = _cloud.retrieve(CLOUD_COLLECTION, ids=[item_id], with_payload=True)
    if not found:
        return {"ok": False}
    cloud_payload = dict(found[0].payload)
    cloud_payload["text"] = cloud_payload["text"] + " [edited at base]"
    cloud_payload["updated_at"] = time.time() + 1  # ensure it looks newer than our last push
    _cloud.upsert(CLOUD_COLLECTION, points=[PointStruct(id=item_id, vector=embed(cloud_payload["text"]), payload=cloud_payload)])
    log_event("conflict", "Simulated a remote edit at base for a synced item")
    return {"ok": True}


def resolve_conflict(item_id: str, keep: str) -> dict:
    points = _edge.retrieve(EDGE_COLLECTION, ids=[item_id], with_payload=True, with_vectors=True)
    if not points:
        return {"ok": False}
    p = points[0]
    text = p.payload["text"]
    if keep == "cloud":
        text = p.payload.get("cloud_text", text)
    elif keep == "newest" and p.payload.get("cloud_time", 0) > p.payload["updated_at"]:
        text = p.payload.get("cloud_text", text)
    new_payload = dict(p.payload)
    new_payload.update({"text": text, "conflict": False, "updated_at": time.time(), "sync_status": "unsynced"})
    new_payload.pop("cloud_text", None)
    new_payload.pop("cloud_time", None)
    _edge.upsert(EDGE_COLLECTION, points=[PointStruct(id=item_id, vector=embed(text), payload=new_payload)])
    log_event("synced", f"Conflict resolved: kept {keep} version")
    return {"ok": True}


def cloud_snapshot(limit: int = 200) -> list[dict]:
    try:
        points, _ = _cloud.scroll(CLOUD_COLLECTION, limit=limit, with_payload=True)
        return sorted([{"id": p.id, **p.payload} for p in points], key=lambda x: x.get("updated_at", 0), reverse=True)
    except Exception:
        return []


def status() -> dict:
    edge_items = list_memory(500)
    last_sync = None
    for row in get_log(50):
        if row["kind"] == "synced" and "Pushed" in row["text"]:
            last_sync = row["ts"]
            break
    return {
        "device_count_local": sum(1 for i in edge_items if i["tag"] == "local"),
        "device_count_total": len(edge_items),
        "pending": sum(1 for i in edge_items if i["tag"] == "sync" and i["sync_status"] != "synced" and not i.get("conflict")),
        "synced": sum(1 for i in edge_items if i["sync_status"] == "synced"),
        "conflicts": sum(1 for i in edge_items if i.get("conflict")),
        "cloud_mode": CLOUD_MODE,
        "cloud_reachable": cloud_reachable(),
        "last_sync_at": last_sync,
    }
