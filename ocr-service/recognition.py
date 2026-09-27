"""Orientation and recognition helpers, independent of the HTTP endpoint."""
import re
import unicodedata

import cv2
import numpy as np


def orientation_score(result) -> float:
    """Reward readable labels, dates and horizontal text, not grid lines."""
    if not result:
        return 0.0
    score = 0.0
    for box, text, confidence in result:
        text = unicodedata.normalize("NFKC", text)
        width = max(p[0] for p in box) - min(p[0] for p in box)
        height = max(p[1] for p in box) - min(p[1] for p in box)
        if width < height:
            continue
        labels = len(re.findall(r"注文|発注|品名|部品|品目|数量|単価|金額|番号|納期|納入|株式会社|TEL|FAX", text))
        score += float(confidence) * (min(len(text), 25) + labels * 20)
    return score


def orient_page(img: np.ndarray, preview_engine) -> tuple[np.ndarray, int]:
    """Choose a whole-page rotation; crop angle classification cannot fix layout.

    Disable per-crop flipping during this comparison, otherwise upside-down
    pages score as well as upright pages while their label/value geometry differs.
    """
    scale = min(1.0, 1200 / max(img.shape[:2]))
    preview = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1 else img
    best_turn, best_score = 0, -1.0
    for turns in range(4):
        result, _ = preview_engine(np.ascontiguousarray(np.rot90(preview, turns)), use_cls=False)
        score = orientation_score(result)
        if score > best_score:
            best_turn, best_score = turns, score
    return np.ascontiguousarray(np.rot90(img, best_turn)), (best_turn * 90) % 360


def box_overlap(a, b):
    ax0, ay0 = np.min(a, axis=0)
    ax1, ay1 = np.max(a, axis=0)
    bx0, by0 = np.min(b, axis=0)
    bx1, by1 = np.max(b, axis=0)
    intersection = max(0, min(ax1, bx1)-max(ax0,bx0))*max(0,min(ay1,by1)-max(ay0,by0))
    return intersection / max(1, (ax1-ax0)*(ay1-ay0)+(bx1-bx0)*(by1-by0)-intersection)


def merge_recognition(multilingual, japanese):
    """Use multilingual reads for codes/numbers and Japanese reads for kana.

    Both are readings of the same pixels, never guesses from a company template.
    Lower confidence on disagreement so the scan review asks for confirmation.
    """
    output = []
    for box, text, score in multilingual or []:
        candidates = [(box_overlap(box,b), t, s) for b,t,s in japanese or []]
        match = max(candidates, default=(0,"",0), key=lambda c:c[0])
        if match[0] > 0.7:
            jt = unicodedata.normalize("NFKC", match[1])
            mt = unicodedata.normalize("NFKC", text)
            # Addresses contain digits: retain the multilingual reading, which
            # also handles the postal mark and Latin part numbers more reliably.
            if re.search(r"[\u3040-\u9fff]", jt) and not re.search(r"\d", jt):
                text, score = match[1], match[2]
            if re.sub(r"\s", "", mt) != re.sub(r"\s", "", jt):
                score = min(float(score), 0.74)
        output.append((box, text, score))
    # Preserve Japanese-only detections (e.g. a faint product name).
    for box,text,score in japanese or []:
        if not any(box_overlap(box,b) > 0.7 for b,_,_ in multilingual or []):
            output.append((box,text,min(float(score),0.74)))
    return output


def recognize_page(img: np.ndarray, engine, japanese_engine, preview_engine):
    upright, rotation = orient_page(img, preview_engine)
    result, _ = engine(upright)
    japanese, _ = japanese_engine(upright)
    return merge_recognition(result, japanese), rotation
