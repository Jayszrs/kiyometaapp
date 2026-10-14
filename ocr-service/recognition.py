"""Orientation and recognition helpers, independent of the HTTP endpoint."""
import re
import unicodedata
import time
import logging

import cv2
import numpy as np

LABEL_PATTERN = re.compile(r"注文(?:番号|No|Na)|品目(?:コード|名)|発注(?:日|数量|単価|金額)|指定納入(?:日|数)|図面番号|部品名|数量|単価|合計金額|処理名|納期|名称|株式会社|備考|納入(?:日|数|単価|金額)")
def label_strength(text):
    text = unicodedata.normalize("NFKC",text).translate(str.maketrans({"额":"額","发":"発","纳":"納","单":"単","书":"書","价":"価"}))
    return len(LABEL_PATTERN.findall(text))



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


def orient_page(img: np.ndarray, preview_engine, check=lambda: None) -> tuple[np.ndarray, int]:
    """One detector pass and recognition of at most eight representative lines.

    Box geometry chooses the page axis. Reading the same crops in both directions
    distinguishes upright from upside-down without four whole-page OCR passes.
    """
    started = time.monotonic()
    check()
    scale = min(1.0, 1200 / max(img.shape[:2]))
    preview = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1 else img
    boxes, _ = preview_engine(preview, use_cls=False, use_rec=False)
    check()
    if not boxes:
        return img, 0
    boxes = np.asarray(boxes,dtype=np.float32)
    horizontal = vertical = 0.0
    for box in boxes:
        width,height = np.ptp(box,axis=0)
        if max(width,height) < 2*max(1,min(width,height)): continue
        weight = np.sqrt(max(1,width*height))
        if width >= height: horizontal += weight
        else: vertical += weight
    turns = 3 if vertical > horizontal else 0
    if turns:
        h = preview.shape[0]
        preview = np.ascontiguousarray(np.rot90(preview,turns))
        boxes = np.stack((h-1-boxes[:,:,1],boxes[:,:,0]),axis=2)
        ordered = []
        for box in boxes:
            total = box.sum(axis=1); diff = np.diff(box,axis=1).ravel()
            ordered.append([box[total.argmin()],box[diff.argmin()],box[total.argmax()],box[diff.argmax()]])
        boxes = np.asarray(ordered,np.float32)
    selected = sorted(boxes,key=lambda b: float(np.prod(np.ptp(b,axis=0))),reverse=True)
    selected = [b for b in selected if np.ptp(b,axis=0)[0] >= 1.5*np.ptp(b,axis=0)[1]][:4]
    if selected:
        crops = preview_engine.get_crop_img_list(preview,np.asarray(selected,np.float32))
        scores = []
        for flip in (0,2):
            check()
            readings,_ = preview_engine.text_rec([np.ascontiguousarray(np.rot90(c,flip)) for c in crops])
            scores.append(orientation_score([(b,t,c) for b,(t,c) in zip(selected,readings)]))
        if scores[1] > scores[0]: turns = (turns+2)%4
    logging.getLogger("kiyometa-ocr").info("orientation %.3fs, %d degrees, %d crops",time.monotonic()-started,turns*90,len(selected))
    return np.ascontiguousarray(np.rot90(img,turns)),turns*90


def rectify_document(img: np.ndarray) -> np.ndarray:
    """Warp a clearly visible bright page only; leave uncertain edges alone."""
    scale = min(1.0, 1200 / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1 else img
    gray = cv2.GaussianBlur(cv2.cvtColor(small,cv2.COLOR_BGR2GRAY),(5,5),0)
    _,mask = cv2.threshold(gray,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    # Text and table rules otherwise split the sheet into individual cells.
    # Close those small holes before finding the outer paper/screen boundary.
    mask = cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((11,11),np.uint8))
    coverage = np.mean(mask > 0,axis=1)
    rows = np.flatnonzero(coverage > max(0.35,float(coverage.max())*0.65))
    if len(rows) and 0 < rows[0] < small.shape[0]*0.35:
        # A narrow bright screen edge can connect toolbars to the paper. Exclude
        # those sparse leading rows before measuring the document component.
        mask[:rows[0]] = 0
    contours,_ = cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not contours: return img
    contour = max(contours,key=cv2.contourArea)
    fraction = cv2.contourArea(contour)/(small.shape[0]*small.shape[1])
    quad = cv2.approxPolyDP(contour,0.02*cv2.arcLength(contour,True),True)
    if not 0.35 < fraction < 0.94: return img
    if len(quad) != 4 or not cv2.isContourConvex(quad):
        # A camera often clips a paper edge. Cropping its bright component still
        # removes browser chrome, without inventing uncertain perspective edges.
        x,y,w,h = cv2.boundingRect(contour)
        if w*h > small.shape[0]*small.shape[1]*0.95: return img
        x0,y0 = max(0,int(x/scale)-2),max(0,int(y/scale)-2)
        x1,y1 = min(img.shape[1],int((x+w)/scale)+2),min(img.shape[0],int((y+h)/scale)+2)
        return np.ascontiguousarray(img[y0:y1,x0:x1])
    points = quad.reshape(4,2).astype(np.float32)/scale
    total = points.sum(axis=1); difference = np.diff(points,axis=1).ravel()
    ordered = np.array([points[total.argmin()],points[difference.argmin()],
                        points[total.argmax()],points[difference.argmax()]],np.float32)
    if len(np.unique(ordered,axis=0)) != 4: return img
    tl,tr,br,bl = ordered
    width = round(max(np.linalg.norm(tr-tl),np.linalg.norm(br-bl)))
    height = round(max(np.linalg.norm(bl-tl),np.linalg.norm(br-tr)))
    if width < 200 or height < 200 or not 0.3 < width/height < 3.5: return img
    matrix = cv2.getPerspectiveTransform(ordered,np.array([[0,0],[width-1,0],[width-1,height-1],[0,height-1]],np.float32))
    return cv2.warpPerspective(img,matrix,(width,height),flags=cv2.INTER_CUBIC,borderValue=(255,255,255))


def prepare_photo(img: np.ndarray) -> np.ndarray:
    """Deskew small angles using long printed table rules."""
    scale = min(1.0, 1400 / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1 else img
    edges = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 60, 160)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 1800, 80,
                            minLineLength=max(100, small.shape[1] // 4), maxLineGap=20)
    angles = []
    for x0,y0,x1,y1 in ([] if lines is None else lines.reshape(-1,4)):
        angle = np.degrees(np.arctan2(y1-y0,x1-x0))
        if abs(angle) <= 12:
            angles.append(angle)
    if len(angles) < 3:
        return img
    angle = float(np.median(angles))
    if abs(angle) < 0.25 or np.median(np.abs(np.array(angles)-angle)) > 1.5:
        return img
    h,w = img.shape[:2]
    matrix = cv2.getRotationMatrix2D((w/2,h/2), angle, 1)
    cos,sin = abs(matrix[0,0]),abs(matrix[0,1])
    nw,nh = int(h*sin+w*cos),int(h*cos+w*sin)
    matrix[0,2] += (nw-w)/2
    matrix[1,2] += (nh-h)/2
    return cv2.warpAffine(img,matrix,(nw,nh),flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT,borderValue=(255,255,255))


def remove_table_rules(img):
    """Remove long thin rules, which often touch small parenthesized labels."""
    gray = cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    _,ink = cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
    horizontal = cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((1,max(80,img.shape[1]//20)),np.uint8))
    vertical = cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((max(80,img.shape[0]//20),1),np.uint8))
    rules = cv2.bitwise_or(horizontal,vertical)
    if not 0 < np.mean(rules > 0) < 0.035: return img
    return cv2.inpaint(img,rules,2,cv2.INPAINT_TELEA)


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
            # Preserve a fully read header over a higher-confidence damaged one.
            # PP-OCRv5 is also the primary reader for mixed-script company names.
            company = bool(re.search(r"株式会社|㈱|\(株\)",mt)) and float(score) >= 0.8
            if (not company and label_strength(jt) >= label_strength(mt)
                    and re.search(r"[\u3040-\u9fff]", jt) and not re.search(r"\d", jt)
                    and float(match[2]) >= float(score)-0.08):
                text, score = match[1], match[2]
            if re.sub(r"\s", "", mt) != re.sub(r"\s", "", jt):
                score = min(float(score), 0.74)
        output.append((box, text, score))
    # Preserve Japanese-only detections (e.g. a faint product name).
    for box,text,score in japanese or []:
        if not any(box_overlap(box,b) > 0.7 for b,_,_ in multilingual or []):
            output.append((box,text,min(float(score),0.74)))
    return output


def recognize_page(img: np.ndarray, engine, japanese_engine, preview_engine, photo=False, check=lambda: None):
    if photo:
        img = rectify_document(img)
        # Area resampling suppresses display moire before 48px text crops are
        # formed, and avoids recognising noisy 12MP camera pixels twice.
        scale = min(1.0, 2400 / max(img.shape[:2]))
        if scale < 1: img = cv2.resize(img,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
    upright, rotation = orient_page(img, preview_engine, check)
    if photo:
        upright = prepare_photo(upright)
    started = time.monotonic()
    check()
    # Both language engines use the same detector/classifier. Share all raw
    # detections BEFORE text-score filtering, so Japanese-only/faint readings
    # are retained rather than reusing only the multilingual engine's survivors.
    boxes, _ = engine(upright, use_cls=False, use_rec=False)
    check()
    if not boxes: return [], rotation
    boxes = np.asarray(boxes,np.float32)
    crops = engine.get_crop_img_list(upright,boxes)
    crops, _, _ = engine.text_cls(crops)
    check()
    detection_done = time.monotonic()
    readings, _ = engine.text_rec(crops)
    if photo:
        retries = [i for i,(text,score) in enumerate(readings)
                   if score < 0.9 and len(text) <= 22 and not label_strength(text)
                   and (re.search(r"[()（）]",text) or re.search(r"[\u3040-\u30ff]",text))][:6]
        if retries:
            enhanced = []
            for i in retries:
                crop = remove_table_rules(crops[i])
                gray = cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
                gray = cv2.createCLAHE(clipLimit=2,tileGridSize=(4,4)).apply(gray)
                enhanced.append(cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR))
            alternatives,_ = engine.text_rec(enhanced)
            for i,reading in zip(retries,alternatives):
                if label_strength(reading[0]) > label_strength(readings[i][0]) or reading[1] > readings[i][1]+0.03:
                    readings[i] = reading
    check()
    multilingual_done = time.monotonic()
    # High-confidence Latin codes/dates/numbers do not benefit from a second
    # Japanese recognition. Keep low-confidence crops for Japanese-only text.
    japanese_indices = [i for i,(text,score) in enumerate(readings)
                        if score < 0.92 and not (score >= 0.65 and label_strength(text))]
    japanese_readings = [("",0.0)]*len(crops)
    if japanese_indices:
        selected_readings, _ = japanese_engine.text_rec([crops[i] for i in japanese_indices])
        for i,reading in zip(japanese_indices,selected_readings): japanese_readings[i] = reading
    check()
    result = [(b,t,c) for b,(t,c) in zip(boxes,readings) if c >= 0.3]
    japanese = [(b,t,c) for b,(t,c) in zip(boxes,japanese_readings) if c >= 0.3]
    logging.getLogger("kiyometa-ocr").info(
        "recognition %.3fs: detection/classification %.3fs, multilingual %.3fs, Japanese %.3fs, %d boxes",
        time.monotonic()-started,detection_done-started,multilingual_done-detection_done,
        time.monotonic()-multilingual_done,len(boxes))
    return merge_recognition(result,japanese), rotation
