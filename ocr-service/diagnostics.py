"""Log JSON terpusat. Tidak menerima payload bisnis atau dokumen."""
import json
import logging
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path

_writers = {}
_MAX_FILE_BYTES = 10 * 1024 * 1024
_MAX_SOURCE_BYTES = 100 * 1024 * 1024
_RETENTION_SECONDS = 90 * 24 * 60 * 60


class BoundedJsonFileHandler(logging.Handler):
    """Daily searchable JSONL, with size and age bounds per source."""
    def __init__(self, path):
        super().__init__()
        self.path = Path(path)

    def emit(self, record):
        try:
            line = (self.format(record) + "\n").encode("utf-8")
            self.acquire()
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size + len(line) > _MAX_FILE_BYTES:
                    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
                    target = self.path.with_name(f"{self.path.name}.{stamp}.{time.time_ns() % 1_000_000:06d}")
                    os.replace(self.path, target)
                with self.path.open("ab") as stream:
                    stream.write(line)
                self._prune()
            finally:
                self.release()
        except Exception:
            self.handleError(record)

    def _prune(self):
        now = time.time()
        archives = sorted(self.path.parent.glob(self.path.name + ".*"), key=lambda item: item.stat().st_mtime)
        total = self.path.stat().st_size if self.path.exists() else 0
        retained = []
        for item in archives:
            try:
                size = item.stat().st_size
                expired = now - item.stat().st_mtime > _RETENTION_SECONDS
                if expired:
                    item.unlink(missing_ok=True)
                else:
                    total += size
                    retained.append((item, size))
            except OSError:
                continue
        for item, size in retained:
            if total <= _MAX_SOURCE_BYTES:
                break
            try:
                item.unlink(missing_ok=True)
                total -= size
            except OSError:
                pass

def write_event(source, event):
    if source not in ("web", "supabase", "ocr", "deploy"):
        raise ValueError("Sumber log tidak dikenal")
    if source not in _writers:
        directory = Path(os.environ.get("KIYOMETA_LOG_DIR", "/logs"))
        directory.mkdir(parents=True, exist_ok=True)
        logger = logging.getLogger("diagnostics." + source)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        handler = BoundedJsonFileHandler(directory / (source + ".log"))
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        _writers[source] = logger
    allowed = ("event_id", "process_id", "parent_process_id", "request_id", "lifecycle_id", "related_lifecycle_ids", "timestamp", "operation", "stage", "rc", "http_status", "duration_ms", "service_host", "origin", "job_id", "actor_id", "session_id", "device_id", "release_id", "client_ip", "error_class", "error_fingerprint", "component_stack")
    safe = {}
    for key in allowed:
        if key not in event:
            continue
        value = event[key]
        if key == "related_lifecycle_ids" and isinstance(value, list):
            safe[key] = [str(item)[:64] for item in value[:20]]
        elif key == "stage":
            safe[key] = str(value)[:64]
        elif key == "operation":
            safe[key] = str(value)[:160]
        else:
            safe[key] = str(value)[:2000 if key == "component_stack" else 500]
    safe.update(source=source, received_at=datetime.now(timezone.utc).isoformat(), hostname=socket.gethostname(), release_id=os.environ.get("APP_RELEASE", safe.get("release_id", "unknown")))
    stage = safe.get("stage", "proses")
    rc = safe.get("rc", "SYS-001")
    safe["message"] = f"Langkah {stage} selesai" if rc == "00" else f"Langkah {stage} gagal dengan kode {rc}"
    _writers[source].info(json.dumps(safe, ensure_ascii=False))
