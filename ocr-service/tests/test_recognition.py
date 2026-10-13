import io
import unittest
from unittest.mock import patch

import cv2
import numpy as np
import pymupdf
from fastapi import HTTPException, UploadFile
from starlette.requests import Request

import main
from recognition import merge_recognition, orient_page, prepare_photo, rectify_document, recognize_page

BOX = [[0, 0], [150, 0], [150, 20], [0, 20]]


class RecognitionTests(unittest.TestCase):
    def test_orientation_uses_one_detection_and_bounded_crop_recognition(self):
        class Preview:
            def __init__(self): self.detections=0; self.recognized=[]
            def __call__(self,image,**kwargs):
                self.detections+=1
                self.assertions=kwargs
                return [BOX]*20,None
            def get_crop_img_list(self,image,boxes): return [image.copy() for _ in boxes]
            def text_rec(self,crops):
                self.recognized.append(len(crops))
                return [('注文番号 数量 単価',.99) if crop[0,0,0] == 255 else ('garbled',.1) for crop in crops],None
        image=np.zeros((30,200,3),np.uint8); image[0,0]=255
        preview=Preview()
        upright,angle=orient_page(image,preview)
        self.assertEqual(angle,0)
        self.assertEqual(preview.detections,1)
        self.assertFalse(preview.assertions['use_cls'])
        self.assertFalse(preview.assertions['use_rec'])
        self.assertEqual(preview.recognized,[8,8])
        np.testing.assert_array_equal(upright,image)
        flipped=np.rot90(image,2).copy()
        corrected,angle=orient_page(flipped,Preview())
        self.assertEqual(angle,180)
        np.testing.assert_array_equal(corrected,image)

    def test_empty_orientation_detection_does_not_trigger_four_ocr_passes(self):
        calls=[]
        def engine(image,**kwargs):
            calls.append(kwargs)
            return None,None
        image=np.zeros((30,50,3),np.uint8)
        upright,angle=orient_page(image,engine)
        self.assertEqual(angle,0)
        self.assertEqual(len(calls),1)
        np.testing.assert_array_equal(upright,image)

    def test_both_languages_share_unfiltered_detection_and_classification(self):
        class Engine:
            def __init__(self,reading): self.reading=reading; self.detections=0; self.classifications=0
            def __call__(self,image,**kwargs):
                self.detections+=1
                self.assertions=kwargs
                return [BOX],None
            def get_crop_img_list(self,image,boxes): return [image.copy()]
            def text_cls(self,crops):
                self.classifications+=1
                return crops,[],0
            def text_rec(self,crops): return [self.reading for _ in crops],0
        multilingual=Engine(('garbled',.1)); japanese=Engine(('タンク',.99))
        def preview(image,**kwargs): return None,None
        result,angle=recognize_page(np.zeros((30,200,3),np.uint8),multilingual,japanese,preview)
        self.assertEqual(multilingual.detections,1)
        self.assertEqual(japanese.detections,0)
        self.assertEqual(multilingual.classifications,1)
        self.assertFalse(multilingual.assertions['use_rec'])
        self.assertEqual(result[0][1:],('タンク',.74))

    def test_perspective_correction_requires_clear_page_edges(self):
        image = np.zeros((700,1000,3),np.uint8)
        cv2.fillConvexPoly(image,np.array([[100,100],[900,60],[850,600],[150,650]],np.int32),(255,255,255))
        page = rectify_document(image)
        self.assertLess(page.shape[1],image.shape[1])
        self.assertLess(page.shape[0],image.shape[0])
        self.assertGreater(float(page.mean()),240)
        blank = np.full((300,500,3),255,np.uint8)
        np.testing.assert_array_equal(rectify_document(blank),blank)

    def test_blank_photo_stays_unchanged(self):
        image = np.full((300,500,3),255,np.uint8)
        np.testing.assert_array_equal(prepare_photo(image),image)

    def test_small_skew_is_corrected_without_cutting_edges(self):
        image = np.full((500,800,3),255,np.uint8)
        for y in (100,200,300,400): cv2.line(image,(30,y),(770,y),(0,0,0),2)
        matrix = cv2.getRotationMatrix2D((400,250),4,1)
        tilted = cv2.warpAffine(image,matrix,(800,500),borderValue=(255,255,255))
        corrected = prepare_photo(tilted)
        self.assertGreater(corrected.shape[0],tilted.shape[0])
        again = prepare_photo(corrected)
        self.assertEqual(again.shape,corrected.shape)

    def test_japanese_names_and_multilingual_numbers_keep_disagreements_visible(self):
        self.assertEqual(merge_recognition([(BOX, 'タソク(TOP)', .95)], [(BOX, 'タンク(TOP)', .98)])[0][1:], ('タンク(TOP)', .74))
        self.assertEqual(merge_recognition([(BOX, '6,000.', .95)], [(BOX, '6,0o0.', .98)])[0][1:], ('6,000.', .74))
        self.assertEqual(merge_recognition([(BOX, 'NHD-F1772-11', .95)], [(BOX, 'NHD-F1712-11', .98)])[0][1], 'NHD-F1772-11')

    def test_slight_box_differences_do_not_duplicate_text(self):
        shifted = [[x+6,y] for x,y in BOX]
        result=merge_recognition([(BOX,'タンク',.99)],[(shifted,'タンク',.98)])
        self.assertEqual(len(result),1)

    def test_missing_japanese_only_name_is_preserved(self):
        self.assertEqual(merge_recognition([],[(BOX,'タンク',.98)])[0][1:],('タンク',.74))

    def test_pdf_limit_reports_error_instead_of_silently_truncating(self):
        with pymupdf.open() as doc:
            for _ in range(2): doc.new_page()
            with patch.object(main,'MAX_PDF_PAGES',1):
                with self.assertRaisesRegex(ValueError,'Split the file'):
                    main.rasterize_pdf(doc.tobytes())

    def test_empty_upload_returns_400(self):
        with self.assertRaises(HTTPException) as error:
            main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='empty.pdf',file=io.BytesIO()))
        self.assertEqual(error.exception.status_code,400)

    def test_missing_model_returns_actionable_503(self):
        with patch.object(main,'decode_image',return_value=np.zeros((2,2,3),np.uint8)), patch.object(main,'get_ocr',side_effect=RuntimeError('Run python prepare_models.py')):
            with self.assertRaises(HTTPException) as error:
                main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='scan.png',file=io.BytesIO(b'image')))
        self.assertEqual(error.exception.status_code,503)
        self.assertNotIn('prepare_models.py',error.exception.detail)

    def test_empty_recognition_returns_422(self):
        with patch.object(main,'decode_image',return_value=np.zeros((2,2,3),np.uint8)), patch.object(main,'get_ocr'), patch.object(main,'get_japanese_ocr'), patch.object(main,'get_preview_ocr'), patch.object(main,'recognize_page',return_value=([],0)):
            with self.assertRaises(HTTPException) as error:
                main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='scan.png',file=io.BytesIO(b'image')))
        self.assertEqual(error.exception.status_code,422)


class UploadLimitTests(unittest.TestCase):
    def test_oversized_upload_is_rejected_before_decoding(self):
        payload = io.BytesIO(b'x' * 64)
        with patch.object(main,'MAX_UPLOAD_BYTES',32):
            with self.assertRaises(HTTPException) as error:
                main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='scan.pdf',file=payload))
        self.assertEqual(error.exception.status_code,413)

    def test_oversized_image_is_rejected(self):
        ok, encoded = cv2.imencode('.png', np.zeros((80,80,3),np.uint8))
        self.assertTrue(ok)
        with patch.object(main,'MAX_PAGE_PIXELS',100):
            with self.assertRaises(ValueError):
                main.decode_image(encoded.tobytes())

    def test_oversized_pdf_page_is_rejected_before_rasterizing(self):
        with pymupdf.open() as doc:
            doc.new_page(width=2000, height=2000)
            with patch.object(main,'MAX_PAGE_PIXELS',1000):
                with self.assertRaisesRegex(ValueError,'lower resolution'):
                    main.rasterize_pdf(doc.tobytes())

    def test_busy_service_reports_429_instead_of_queueing(self):
        held = [main._slots.acquire(blocking=False) for _ in range(main._slots._value)]
        self.assertNotIn(False, held)
        try:
            with self.assertRaises(HTTPException) as error:
                main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='scan.pdf',file=io.BytesIO(b'x')))
            self.assertEqual(error.exception.status_code,429)
        finally:
            for _ in held:
                main._slots.release()

    def test_malformed_pdf_does_not_surface_as_500(self):
        with self.assertRaises(HTTPException) as error:
            main.ocr(Request({"type": "http", "headers": []}), UploadFile(filename='broken.pdf',file=io.BytesIO(b'%PDF-1.7 truncated')))
        self.assertEqual(error.exception.status_code,400)

    def test_filename_cannot_inject_log_lines(self):
        cleaned = main.safe_name('quote.pdf\n2026-01-01 INFO forged entry')
        self.assertNotIn('\n', cleaned)
        self.assertNotIn('\r', cleaned)
        self.assertTrue(cleaned.startswith('quote.pdf'))
        self.assertEqual(main.safe_name('   '), 'upload')
        self.assertTrue(main.safe_name('a'*500 + '.pdf').endswith('.pdf'))

    def test_log_endpoint_is_off_unless_enabled(self):
        with self.assertRaises(HTTPException) as error:
            main.log_message(Request({'type': 'http', 'headers': []}), main.LogIn(message='forged log line'))
        self.assertEqual(error.exception.status_code,404)



if __name__ == '__main__':
    unittest.main()
