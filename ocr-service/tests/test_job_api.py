import unittest
from threading import Event
from unittest.mock import patch
from fastapi.testclient import TestClient
import main
from jobs import OcrJobs

class JobApiTests(unittest.TestCase):
    def test_ack_poll_dedup_cancel_and_owner_isolation(self):
        started=Event(); stopped=Event()
        def work(raw,name,dpi,check):
            started.set()
            while not stopped.wait(.01): check()
            return {'source':name,'lines':[]}
        jobs=OcrJobs(work)
        try:
            with patch.object(main,'_jobs',jobs),patch.object(main,'require_user',side_effect=lambda request:request.headers.get('x-test-owner','alice')):
                with TestClient(main.app) as client:
                    first=client.post('/ocr/jobs',files={'file':('first.pdf',b'%PDF test','application/pdf')})
                    self.assertEqual(first.status_code,202)
                    job_id=first.json()['id']; self.assertTrue(started.wait(1))
                    repeat=client.post('/ocr/jobs',files={'file':('first.pdf',b'%PDF test','application/pdf')})
                    self.assertEqual(repeat.status_code,202)
                    self.assertEqual(repeat.json()['id'],job_id)
                    self.assertEqual(client.get('/ocr/jobs/'+job_id).json()['status'],'running')
                    self.assertEqual(client.get('/ocr/jobs/'+job_id,headers={'x-test-owner':'bob'}).status_code,404)
                    self.assertEqual(client.delete('/ocr/jobs/'+job_id,headers={'x-test-owner':'bob'}).status_code,404)
                    cancelled=client.delete('/ocr/jobs/'+job_id)
                    self.assertEqual(cancelled.status_code,200)
                    self.assertIn(cancelled.json()['status'],('cancelling','cancelled'))
        finally:
            stopped.set();jobs.executor.shutdown(wait=True)

    def test_finished_job_delivers_original_line_contract(self):
        lines=[{'text':'quantity','x0':0,'y0':0,'x1':50,'y1':20,'page':0,'score':.99}]
        jobs=OcrJobs(lambda raw,name,dpi,check:{'source':name,'lines':lines})
        try:
            with patch.object(main,'_jobs',jobs),patch.object(main,'REQUIRE_AUTH',False):
                with TestClient(main.app) as client:
                    job_id=client.post('/ocr/jobs',files={'file':('test.png',b'pixels','image/png')}).json()['id']
                    jobs.executor.shutdown(wait=True)
                    response=client.get('/ocr/jobs/'+job_id)
                    self.assertEqual(response.json()['status'],'done')
                    self.assertEqual(response.json()['result']['lines'],lines)
        finally: jobs.executor.shutdown(wait=True)
