"""Bounded local OCR jobs: short HTTP requests, one inference at a time."""
import hashlib
import logging
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Event, Lock


class JobStopped(Exception):
    def __init__(self, kind):
        self.kind = kind


class JobsBusy(Exception):
    pass


@dataclass
class Job:
    id: str
    owner: str
    fingerprint: str
    created: float
    status: str = "queued"
    cancelled: Event = field(default_factory=Event)
    result: object = None
    error: str = ""


class OcrJobs:
    def __init__(self, work, timeout=300, retention=600):
        self.work = work
        self.timeout = timeout
        self.retention = retention
        self.lock = Lock()
        self.records = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr-job")

    def submit(self, owner, raw, name, dpi):
        fingerprint = hashlib.sha256(raw + str(dpi).encode() + (b"pdf" if name.lower().endswith(".pdf") else b"image")).hexdigest()
        now = time.monotonic()
        with self.lock:
            self.records = {key: job for key, job in self.records.items()
                            if job.status in ("queued", "running", "cancelling") or now-job.created < self.retention}
            for job in self.records.values():
                if job.owner == owner and job.fingerprint == fingerprint and job.status in ("queued", "running", "done"):
                    return job.id
            if sum(job.status in ("queued", "running", "cancelling") for job in self.records.values()) >= 2:
                raise JobsBusy()
            # Results contain bounded OCR lines, never retained source images.
            finished = [job for job in self.records.values() if job.status not in ("queued", "running", "cancelling")]
            for job in sorted(finished,key=lambda job: job.created)[:max(0,len(self.records)-31)]:
                del self.records[job.id]
            job = Job(secrets.token_urlsafe(24),owner,fingerprint,now)
            self.records[job.id] = job
        self.executor.submit(self._run,job,raw,name,dpi)
        return job.id

    def _run(self, job, raw, name, dpi):
        def check():
            if job.cancelled.is_set(): raise JobStopped("cancelled")
            if time.monotonic()-job.created > self.timeout: raise JobStopped("timeout")
        try:
            check()
            with self.lock: job.status = "running"
            result = self.work(raw,name,dpi,check)
            check()
            with self.lock:
                job.result = result
                job.status = "done"
        except JobStopped as error:
            with self.lock:
                job.status = "cancelled" if error.kind == "cancelled" else "error"
                job.error = error.kind
        except Exception as error:
            logging.getLogger("kiyometa-ocr").exception("OCR job failed: %s",job.id)
            status = getattr(error,"status_code",503)
            with self.lock:
                job.status = "error"
                job.error = "unreadable" if status in (400,422) else "size" if status == 413 else "service"
        finally:
            logging.getLogger("kiyometa-ocr").info("OCR job %s: %s (%.3fs)",job.id,job.status,time.monotonic()-job.created)

    def read(self, owner, job_id):
        with self.lock:
            job = self.records.get(job_id)
            if job is None or job.owner != owner: raise KeyError(job_id)
            return {"id":job.id,"status":job.status,"result":job.result if job.status == "done" else None,"error":job.error}

    def cancel(self, owner, job_id):
        with self.lock:
            job = self.records.get(job_id)
            if job is None or job.owner != owner: raise KeyError(job_id)
            if job.status in ("queued","running","cancelling"):
                job.cancelled.set()
                job.status = "cancelling"
        return self.read(owner,job_id)

    def shutdown(self):
        with self.lock:
            for job in self.records.values():
                if job.status in ("queued", "running", "cancelling"):
                    job.cancelled.set()
        self.executor.shutdown(wait=False, cancel_futures=True)
