import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import diagnostics


class DiagnosticsWriterTests(unittest.TestCase):
    def tearDown(self):
        diagnostics._writers.clear()

    def test_writer_keeps_allowlisted_fields_and_drops_payloads(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "KIYOMETA_LOG_DIR": folder,
            "APP_RELEASE": "release-test",
        }):
            diagnostics._writers.clear()
            diagnostics.write_event("web", {
                "event_id": "event-1",
                "process_id": "process-1",
                "operation": "order.save",
                "stage": "request.end",
                "rc": "00",
                "http_status": 200,
                "password": "must-not-be-written",
                "document_text": "private document data",
                "request_body": {"total": 1234},
            })

            path = Path(folder) / "web.log"
            record = json.loads(path.read_text(encoding="utf-8").strip())

        self.assertEqual(record["process_id"], "process-1")
        self.assertEqual(record["release_id"], "release-test")
        self.assertEqual(record["source"], "web")
        self.assertNotIn("password", record)
        self.assertNotIn("document_text", record)
        self.assertNotIn("request_body", record)
        self.assertNotIn("must-not-be-written", json.dumps(record))
        self.assertNotIn("private document data", json.dumps(record))

    def test_writer_rejects_unknown_log_source(self):
        with self.assertRaisesRegex(ValueError, "Sumber log tidak dikenal"):
            diagnostics.write_event("unknown", {"stage": "request.end"})


if __name__ == "__main__":
    unittest.main()
