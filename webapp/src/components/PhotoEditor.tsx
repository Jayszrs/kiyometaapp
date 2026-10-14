import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { preparePhoto } from "../lib/ocrClient";

type Crop = { left: number; top: number; right: number; bottom: number };
const full: Crop = { left: 0, top: 0, right: 100, bottom: 100 };
export default function PhotoEditor({ file, lang, onConfirm, onCancel, onRetake }: {
  file: File; lang: "en" | "ja"; onConfirm: (file: File) => void; onCancel: () => void; onRetake: () => void;
}) {
  const ja = lang === "ja";
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [straighten, setStraighten] = useState(0);
  const angle = quarterTurns * 90 + straighten;
  const [crop, setCrop] = useState<Crop>(full);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const imageSurface = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const drag = useRef<{ id: number; corner: number; x: number; y: number; crop: Crop } | null>(null);
  const [dragging, setDragging] = useState(false);
  const endDrag = () => { drag.current = null; setDragging(false); };
  useEffect(() => {
    const endDrag = () => { drag.current = null; setDragging(false); };
    window.addEventListener("blur", endDrag);
    return () => window.removeEventListener("blur", endDrag);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    let active = true;
    setImage(null); setError(false); setPreview(false); setCrop(full);
    void preparePhoto(file, controller.signal).then(blob => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { if (active) setImage(img); };
      img.onerror = () => { if (active) setError(true); };
      img.src = url;
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file]);
  const rotated = useMemo(() => {
    if (!image) return null;
    const radians = angle * Math.PI / 180;
    const w = image.naturalWidth, h = image.naturalHeight;
    const rotated = document.createElement("canvas");
    const rw = Math.ceil(Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians)));
    const rh = Math.ceil(Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians)));
    // Slider interactions render a small preview; export uses source pixels.
    const scale = Math.min(1, 1200 / Math.max(rw, rh));
    rotated.width = Math.max(1, Math.round(rw * scale));
    rotated.height = Math.max(1, Math.round(rh * scale));
    const ctx = rotated.getContext("2d")!;
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, rotated.width, rotated.height);
    ctx.scale(scale, scale);
    ctx.translate(rw / 2, rh / 2); ctx.rotate(radians);
    ctx.drawImage(image, -w / 2, -h / 2);
    return rotated;
  }, [image, angle]);
  useEffect(() => {
    if (!rotated || !canvas.current) return;
    const target = canvas.current;
    const x = preview ? crop.left / 100 * rotated.width : 0;
    const y = preview ? crop.top / 100 * rotated.height : 0;
    const cw = preview ? (crop.right - crop.left) / 100 * rotated.width : rotated.width;
    const ch = preview ? (crop.bottom - crop.top) / 100 * rotated.height : rotated.height;
    const scale = Math.min(1, 1200 / Math.max(cw, ch));
    target.width = Math.round(cw * scale); target.height = Math.round(ch * scale);
    target.getContext("2d")!.drawImage(rotated, x, y, cw, ch, 0, 0, target.width, target.height);
  }, [rotated, preview, crop]);
  const rotate = (direction: number) => {
    setQuarterTurns(a => (a + direction + 4) % 4);
    setStraighten(0); setCrop(full); setPreview(false);
  };
  const reset = () => { setQuarterTurns(0); setStraighten(0); setCrop(full); setPreview(false); };
  const beginDrag = (e: React.PointerEvent<HTMLButtonElement>, corner: number) => {
    if (drag.current || saving) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    drag.current = { id: e.pointerId, corner, x: e.clientX, y: e.clientY, crop };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== e.pointerId || !imageSurface.current) return;
    const rect = imageSurface.current.getBoundingClientRect();
    const dx = (e.clientX - current.x) / rect.width * 100;
    const dy = (e.clientY - current.y) / rect.height * 100;
    const c = current.crop, corner = current.corner;
    if (corner === 4) {
      const x = Math.max(-c.left, Math.min(100-c.right, dx));
      const y = Math.max(-c.top, Math.min(100-c.bottom, dy));
      setCrop({ left: c.left+x, right: c.right+x, top: c.top+y, bottom: c.bottom+y });
      return;
    }
    setCrop({
      left: corner === 0 || corner === 3 ? Math.max(0, Math.min(c.left+dx, c.right-5)) : c.left,
      right: corner === 1 || corner === 2 ? Math.min(100, Math.max(c.right+dx, c.left+5)) : c.right,
      top: corner < 2 ? Math.max(0, Math.min(c.top+dy, c.bottom-5)) : c.top,
      bottom: corner >= 2 ? Math.min(100, Math.max(c.bottom+dy, c.top+5)) : c.bottom,
    });
  };
  const cropKey = (e: React.KeyboardEvent<HTMLButtonElement>, corner: number) => {
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    setCrop(c => {
      if (corner === 4) {
        const x = Math.max(-c.left, Math.min(100-c.right, dx));
        const y = Math.max(-c.top, Math.min(100-c.bottom, dy));
        return { left: c.left+x, right: c.right+x, top: c.top+y, bottom: c.bottom+y };
      }
      const horizontal = corner === 0 || corner === 3 ? "left" : "right";
      const vertical = corner < 2 ? "top" : "bottom";
      const next = { ...c, [horizontal]: Math.max(0, Math.min(100,c[horizontal]+dx)), [vertical]: Math.max(0,Math.min(100,c[vertical]+dy)) };
      return next.right-next.left >= 5 && next.bottom-next.top >= 5 ? next : c;
    });
  };
  const confirm = async () => {
    if (!image || !rotated || saving) return;
    setSaving(true);
    try {
      const radians = angle * Math.PI / 180;
      const iw = image.naturalWidth, ih = image.naturalHeight;
      const rw = Math.ceil(Math.abs(iw * Math.cos(radians)) + Math.abs(ih * Math.sin(radians)));
      const rh = Math.ceil(Math.abs(iw * Math.sin(radians)) + Math.abs(ih * Math.cos(radians)));
      const output = document.createElement("canvas");
      const w = (crop.right - crop.left) * rw / 100;
      const h = (crop.bottom - crop.top) * rh / 100;
      const scale = Math.min(1, 4000 / Math.max(w, h));
      output.width = Math.max(1, Math.round(w * scale)); output.height = Math.max(1, Math.round(h * scale));
      const ctx = output.getContext("2d")!;
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, output.width, output.height);
      ctx.scale(scale, scale);
      ctx.translate(-crop.left * rw / 100, -crop.top * rh / 100);
      ctx.translate(rw / 2, rh / 2); ctx.rotate(radians);
      ctx.drawImage(image, -iw / 2, -ih / 2);
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(), "image/jpeg", .95));
      if (mounted.current) onConfirm(new File([blob], "quotation-photo.jpg", { type: "image/jpeg" }));
    } catch { setError(true); }
    finally { setSaving(false); }
  };
  const button = "photo-tool inline-flex min-h-11 items-center justify-center gap-2 rounded-sm px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
  const cropStyle = { left: `${crop.left}%`, top: `${crop.top}%`, width: `${crop.right-crop.left}%`, height: `${crop.bottom-crop.top}%` };
  const corners = ja ? ["左上", "右上", "右下", "左下"] : ["Top left", "Top right", "Bottom right", "Bottom left"];
  return <section className="photo-editor flex flex-col p-4 sm:p-5" aria-label={ja ? "写真を調整" : "Adjust your photo"}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <ol className="flex items-center gap-2 text-sm" aria-label={ja ? "読み取りの手順" : "Photo steps"}>
        <li aria-current={!preview ? "step" : undefined} className={`flex items-center gap-1.5 ${!preview ? "font-semibold text-[#1a3458]" : "text-slate-600"}`}>
          <Icon name={preview ? "check" : "crop"} size={16} />{ja ? "切り抜き" : "Crop"}
        </li>
        <li aria-hidden="true"><Icon name="chevron-right" size={14} className="text-slate-400" /></li>
        <li aria-current={preview ? "step" : undefined} className={`flex items-center gap-1.5 ${preview ? "font-semibold text-[#1a3458]" : "text-slate-600"}`}>
          <Icon name="eye" size={16} />{ja ? "確認" : "Preview"}
        </li>
      </ol>
      {!preview && <button className="photo-text-action min-h-11 text-sm text-slate-600" disabled={!image || saving} onClick={reset}>{ja ? "リセット" : "Reset"}</button>}
    </div>
    <h3 className="text-lg font-semibold text-slate-800">{preview ? (ja ? "切り抜きを確認" : "Check your crop") : (ja ? "書類に枠を合わせる" : "Frame your quotation")}</h3>
    <p id="photo-crop-guidance" className="mt-1 mb-4 text-sm leading-relaxed text-slate-600">{preview
      ? (ja ? "必要な項目と文字が鮮明に写っていれば、読み取りを開始できます。" : "Check that the details are visible and the text is clear. Ready? Scan your quotation.")
      : (ja ? "角を動かして必要な項目を囲み、プレビューで確認してください。" : "Drag the corners around the details you need, then preview your crop.")}</p>
    {error && <p role="alert" className="mb-3 text-sm text-red-700">{ja ? "写真を読み込めません。撮り直してください。" : "Could not prepare this photo. Please retake it."}</p>}
    <div className="photo-stage flex min-h-48 items-center justify-center overflow-hidden rounded-sm bg-slate-900 p-7 sm:p-8">
      {!image && !error && <p role="status" className="flex items-center gap-2 text-sm text-white"><Icon name="loader" className="animate-spin" />{ja ? "写真を読み込み中…" : "Loading photo…"}</p>}
      <div ref={imageSurface} className={`photo-surface relative max-w-full ${!image ? "hidden" : ""}`} style={{ touchAction: "none" }}
        onPointerMove={move} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <canvas ref={canvas} className="block max-w-full" style={{ maxHeight: "min(34vh, 340px)", width: "auto", height: "auto" }}
          role="img" aria-label={preview ? (ja ? "読み取る写真のプレビュー" : "Preview of the photo to scan") : (ja ? "切り抜く写真" : "Photo to crop")} />
        {image && !preview && <>
          <svg className="absolute inset-0 h-full w-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={`M0 0H100V100H0Z M${crop.left} ${crop.top}V${crop.bottom}H${crop.right}V${crop.top}Z`} fill="rgb(15 23 42 / .62)" fillRule="evenodd" /></svg>
          <button className="photo-crop-area absolute border border-white/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14a085]" style={{ ...cropStyle, touchAction: "none" }}
            aria-label={ja ? "切り抜き枠を移動" : "Move crop area"} aria-describedby="photo-crop-guidance" disabled={saving}
            onPointerDown={e => beginDrag(e, 4)} onKeyDown={e => cropKey(e, 4)}>
            <svg className={`absolute inset-0 h-full w-full pointer-events-none ${dragging ? "opacity-70" : "opacity-30"}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M33.333 0V100M66.667 0V100M0 33.333H100M0 66.667H100" stroke="white" strokeWidth=".5" vectorEffect="non-scaling-stroke" /></svg>
          </button>
          {[[crop.left,crop.top],[crop.right,crop.top],[crop.right,crop.bottom],[crop.left,crop.bottom]].map(([x,y],i) => <button key={i}
            aria-label={`${corners[i]} ${ja ? "の角を調整" : "crop corner"}`} aria-describedby="photo-crop-guidance" disabled={saving}
            className="photo-corner absolute flex h-11 w-11 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14a085]"
            style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)", touchAction: "none" }}
            onKeyDown={e => cropKey(e,i)} onPointerDown={e => beginDrag(e,i)}>
            <span className="photo-corner-mark pointer-events-none absolute left-1/2 top-1/2 block h-5 w-5 border-t-[3px] border-l-[3px] border-white" style={{ transform: `rotate(${i*90}deg)`, transformOrigin: "0 0" }} />
          </button>)}
        </>}
      </div>
    </div>
    {!preview ? <div className="photo-adjustments mt-3 grid gap-3 sm:grid-cols-[auto_1fr] sm:gap-5">
      <div className="flex items-center justify-center gap-1 sm:justify-start" role="group" aria-label={ja ? "写真を回転" : "Rotate photo"}>
        <button className={button} disabled={!image || saving} onClick={() => rotate(-1)} title={ja ? "左に90度回転" : "Rotate left 90°"} aria-label={ja ? "左に90度回転" : "Rotate left 90°"}><Icon name="rotate-ccw" />{ja ? "左" : "Left"}</button>
        <span className="h-5 w-px bg-slate-200" aria-hidden="true" />
        <button className={button} disabled={!image || saving} onClick={() => rotate(1)} title={ja ? "右に90度回転" : "Rotate right 90°"} aria-label={ja ? "右に90度回転" : "Rotate right 90°"}><Icon name="rotate-cw" />{ja ? "右" : "Right"}</button>
      </div>
      <div className="min-w-0">
        <div className="flex items-center justify-between text-sm"><label htmlFor="photo-straighten" className="font-medium text-slate-700">{ja ? "傾きを調整" : "Straighten"}</label><output htmlFor="photo-straighten" className="font-mono text-slate-600">{straighten > 0 ? "+" : ""}{straighten.toFixed(1)}°</output></div>
        <input id="photo-straighten" className="photo-straighten w-full" type="range" min={-15} max={15} step={0.1} value={straighten} disabled={!image || saving}
          aria-valuetext={`${straighten.toFixed(1)} ${ja ? "度" : "degrees"}`} onChange={e => setStraighten(Number(e.target.value))} />
      </div>
    </div> : <p className="mt-3 flex items-center gap-2 text-sm text-[#0d7377]" role="status"><Icon name="check" size={16} />{ja ? "この範囲を読み取ります" : "This is the area we'll scan"}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
      {preview ? <button className={button} disabled={saving} onClick={() => setPreview(false)}><Icon name="arrow-left" size={16} />{ja ? "切り抜きを編集" : "Edit crop"}</button>
        : <button className={button} disabled={saving} onClick={onRetake}><Icon name="camera" size={16} />{ja ? "撮り直す" : "Retake"}</button>}
      <button className={`${button} text-slate-600`} disabled={saving} onClick={onCancel}>{ja ? "キャンセル" : "Cancel"}</button>
      <button className="photo-primary ml-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-sm bg-[#1a3458] px-4 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!image || saving || error} onClick={preview ? confirm : () => setPreview(true)}>
        {saving ? <Icon name="loader" size={16} className="animate-spin" /> : <Icon name={preview ? "scan" : "eye"} size={17} />}
        {saving ? (ja ? "処理中…" : "Preparing…") : preview ? (ja ? "見積書を読み取る" : "Scan quotation") : (ja ? "切り抜きを確認" : "Preview crop")}
        {!preview && <Icon name="arrow-right" size={16} />}
      </button>
    </div>
  </section>;
}
