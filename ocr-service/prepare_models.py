"""Download the pinned Japanese-capable PP-OCRv5 recognizer at install/build time.

Source and SHA256 are from RapidAI's v3.9.2 model manifest. Runtime recognition
is local; customer documents are never sent to the model host.
"""
import hashlib
import os
from pathlib import Path
from urllib.request import urlopen

MODELS = {
    "ch_PP-OCRv5_rec_mobile.onnx": ("PP-OCRv5", "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5"),
    "japan_PP-OCRv4_rec_mobile.onnx": ("PP-OCRv4", "e1075a67dba758ecfc7ebc78a10ae61c95ac8fb66a9c86fab5541e33f085cb7a"),
}


def model_path(name: str = "ch_PP-OCRv5_rec_mobile.onnx") -> Path:
    return Path(os.environ.get("OCR_MODEL_DIR", Path(__file__).parent / "models")) / name


def prepare_model(name: str) -> Path:
    version, checksum = MODELS[name]
    dest = model_path(name)
    if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == checksum:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # A failed or interrupted download never replaces a working model.
    temp = dest.with_suffix(".download")
    try:
        url = f"https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/{version}/rec/{name}"
        with urlopen(url, timeout=120) as response, temp.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if hashlib.sha256(temp.read_bytes()).hexdigest() != checksum:
            raise RuntimeError("OCR model checksum does not match the pinned upstream model.")
        temp.replace(dest)
    finally:
        temp.unlink(missing_ok=True)
    return dest


if __name__ == "__main__":
    for name in MODELS:
        print(prepare_model(name))
