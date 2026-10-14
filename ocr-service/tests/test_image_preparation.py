import unittest
import io
from unittest.mock import patch
import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
from fastapi.testclient import TestClient
import main


class ImagePreparationTests(unittest.TestCase):
    def test_pipeline_reports_stage_at_decode_and_recognition(self):
        stages = []
        image = np.zeros((72, 128, 3), dtype=np.uint8)
        def decode(raw):
            self.assertEqual(stages[-1], 'preparing')
            return image
        def recognize(*args, **kwargs):
            self.assertEqual(stages[-1], 'recognizing')
            return [([[0, 0], [30, 0], [30, 20], [0, 20]], '数量', .99)], 0
        with patch.object(main, 'decode_image', side_effect=decode), patch.object(main, 'recognize_page', side_effect=recognize), patch.object(main, 'get_ocr'), patch.object(main, 'get_japanese_ocr'), patch.object(main, 'get_preview_ocr'):
            result = main.run_ocr(UploadFile(filename='photo.jpg', file=io.BytesIO(b'pixels')), 300, lambda stage=None: stages.append(stage) if stage else None)
        self.assertEqual(stages, ['preparing', 'queued', 'recognizing'])
        self.assertEqual(result.lines[0].text, '数量')

    def test_conversion_preserves_dimensions_without_inference(self):
        image = np.full((72, 128, 3), 210, dtype=np.uint8)
        raw = cv2.imencode('.png', image)[1].tobytes()
        with patch.object(main, 'require_user', return_value='alice'), patch.object(main, 'get_ocr', side_effect=AssertionError('Must not run OCR')):
            with TestClient(main.app) as client:
                response = client.post('/ocr/prepare-image', files={'file': ('photo.png', raw, 'image/png')})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-type'], 'image/jpeg')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        decoded = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape, image.shape)

    def test_auth_and_invalid_source(self):
        with TestClient(main.app) as client:
            with patch.object(main, 'require_user', side_effect=HTTPException(status_code=401)), patch.object(main, 'decode_image') as decode:
                response = client.post('/ocr/prepare-image', files={'file': ('photo.heic', b'bad', 'image/heic')})
                self.assertEqual(response.status_code, 401)
                decode.assert_not_called()
            with patch.object(main, 'require_user', return_value='alice'):
                response = client.post('/ocr/prepare-image', files={'file': ('photo.heic', b'bad', 'image/heic')})
                self.assertEqual(response.status_code, 400)
