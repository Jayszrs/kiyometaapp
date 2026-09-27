import io
import unittest
from unittest.mock import patch

import numpy as np
import pymupdf
from fastapi import HTTPException, UploadFile

import main
from recognition import merge_recognition, orient_page

BOX = [[0, 0], [150, 0], [150, 20], [0, 20]]


class RecognitionTests(unittest.TestCase):
    def test_rotation_preserves_geometry_and_disables_crop_flipping(self):
        img = np.zeros((30, 50, 3), dtype=np.uint8)
        img[0, 0] = 255
        def engine(image, **kwargs):
            self.assertFalse(kwargs['use_cls'])
            text = '注文番号 株式会社' if image[-1, 0, 0] == 255 else 'x'
            return [(BOX, text, .99)], None
        upright, angle = orient_page(img, engine)
        self.assertEqual(angle, 90)
        np.testing.assert_array_equal(upright, np.rot90(img))

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
            main.ocr(UploadFile(filename='empty.pdf',file=io.BytesIO()))
        self.assertEqual(error.exception.status_code,400)

    def test_missing_model_returns_actionable_503(self):
        with patch.object(main,'decode_image',return_value=np.zeros((2,2,3),np.uint8)), patch.object(main,'get_ocr',side_effect=RuntimeError('Run python prepare_models.py')):
            with self.assertRaises(HTTPException) as error:
                main.ocr(UploadFile(filename='scan.png',file=io.BytesIO(b'image')))
        self.assertEqual(error.exception.status_code,503)
        self.assertIn('prepare_models.py',error.exception.detail)

    def test_empty_recognition_returns_422(self):
        with patch.object(main,'decode_image',return_value=np.zeros((2,2,3),np.uint8)), patch.object(main,'get_ocr'), patch.object(main,'get_japanese_ocr'), patch.object(main,'get_preview_ocr'), patch.object(main,'recognize_page',return_value=([],0)):
            with self.assertRaises(HTTPException) as error:
                main.ocr(UploadFile(filename='scan.png',file=io.BytesIO(b'image')))
        self.assertEqual(error.exception.status_code,422)


if __name__ == '__main__':
    unittest.main()
