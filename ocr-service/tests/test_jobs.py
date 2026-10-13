import time
import unittest
from threading import Event
from jobs import OcrJobs, JobsBusy


class JobTests(unittest.TestCase):
    def setUp(self):
        self.stop = Event()
        self.started = Event()
        self.calls = 0
        def work(raw,name,dpi,check):
            self.calls += 1
            self.started.set()
            while not self.stop.wait(.01): check()
            check()
            return {"source":name,"lines":[{"text":"quantity"}]}
        self.jobs = OcrJobs(work)

    def tearDown(self):
        self.stop.set()
        self.jobs.executor.shutdown(wait=True)

    def terminal(self, owner, job_id):
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            result=self.jobs.read(owner,job_id)
            if result['status'] in ('done','error','cancelled'): return result
            time.sleep(.01)
        self.fail('job did not stop')

    def test_reupload_reuses_running_and_finished_job(self):
        job_id=self.jobs.submit('user',b'pdf','quotation.pdf',300)
        self.assertTrue(self.started.wait(1))
        self.assertEqual(self.jobs.submit('user',b'pdf','quotation.pdf',300),job_id)
        self.stop.set()
        self.assertEqual(self.terminal('user',job_id)['status'],'done')
        self.assertEqual(self.jobs.submit('user',b'pdf','quotation.pdf',300),job_id)
        self.assertEqual(self.calls,1)

    def test_different_document_queues_and_does_not_fail_after_ten_seconds(self):
        first=self.jobs.submit('user',b'one','one.pdf',300)
        self.assertTrue(self.started.wait(1))
        second=self.jobs.submit('user',b'two','two.pdf',300)
        self.assertEqual(self.jobs.read('user',second)['status'],'queued')
        self.stop.set()
        self.assertEqual(self.terminal('user',first)['status'],'done')
        self.assertEqual(self.terminal('user',second)['status'],'done')

    def test_cancellation_stops_work_and_releases_capacity(self):
        job_id=self.jobs.submit('user',b'pdf','quotation.pdf',300)
        self.assertTrue(self.started.wait(1))
        self.jobs.cancel('user',job_id)
        self.assertEqual(self.terminal('user',job_id)['status'],'cancelled')
        self.stop.set()
        retry=self.jobs.submit('user',b'pdf','quotation.pdf',300)
        self.assertNotEqual(retry,job_id)
        self.assertEqual(self.terminal('user',retry)['status'],'done')

    def test_other_users_cannot_read_cancel_or_reuse_job(self):
        job_id=self.jobs.submit('user',b'pdf','quotation.pdf',300)
        with self.assertRaises(KeyError): self.jobs.read('other',job_id)
        with self.assertRaises(KeyError): self.jobs.cancel('other',job_id)
        self.assertNotEqual(self.jobs.submit('other',b'pdf','quotation.pdf',300),job_id)

    def test_admission_is_bounded(self):
        self.jobs.submit('user',b'one','one.pdf',300)
        self.jobs.submit('user',b'two','two.pdf',300)
        with self.assertRaises(JobsBusy): self.jobs.submit('user',b'three','three.pdf',300)

    def test_server_deadline_is_reported_as_timeout(self):
        self.jobs.timeout=.02
        job_id=self.jobs.submit('user',b'pdf','quotation.pdf',300)
        result=self.terminal('user',job_id)
        self.assertEqual(result['status'],'error')
        self.assertEqual(result['error'],'timeout')
