import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMediaQuery } from "../lib/useMediaQuery";

// The column that has to survive every drag. `useResizablePanel` never lets a
// side panel grow so wide that the flex-1 main column drops below this.
const MAIN_MIN_WIDTH = 320;
const KEYBOARD_STEP = 16;
const RESIZE_BREAKPOINT = "(min-width: 768px)";

export interface ResizeHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

interface ResizablePanelOptions {
  initial: number;
  min: number;
  max: number;
  storageKey?: string;
}

interface ResizeBounds {
  lower: number;
  upper: number;
}

function readStoredWidth(storageKey: string | undefined, initial: number, min: number, max: number): number {
  if (!storageKey) return initial;
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? Math.min(max, Math.max(min, stored)) : initial;
  } catch {
    return initial;
  }
}

// Attach the returned `panelRef` to the panel element and spread
// `handleProps` onto a <ResizeHandle /> placed on the panel's inner edge.
// Widths are applied straight to the DOM during a drag so the rest of the page
// (large forms, lists) never re-renders per pointer move; React state only
// catches up once the drag ends, which keeps the gesture smooth on a tablet.
export function useResizablePanel<T extends HTMLElement = HTMLElement>({ initial, min, max, storageKey }: ResizablePanelOptions) {
  const isWide = useMediaQuery(RESIZE_BREAKPOINT);
  const panelRef = useRef<T | null>(null);
  const dragState = useRef<{ startX: number; startWidth: number; bounds: ResizeBounds } | null>(null);

  const [width, setWidth] = useState(() => readStoredWidth(storageKey, initial, min, max));

  const persist = useCallback((value: number) => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {
      // Private mode / quota: keep the in-memory width and move on.
    }
  }, [storageKey]);

  // Container-aware limits. The longest this panel may grow is what is left
  // once every other fixed column and the minimum main width are subtracted, so
  // a drag can never squeeze the working area out of existence.
  const measureBounds = useCallback((): ResizeBounds => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return { lower: min, upper: max };
    const main = parent.querySelector(":scope > main") as HTMLElement | null;
    let siblings = 0;
    for (const child of Array.from(parent.children) as HTMLElement[]) {
      if (child === panel || child === main) continue;
      siblings += child.getBoundingClientRect().width;
    }
    const upper = Math.max(0, Math.min(max, parent.clientWidth - siblings - MAIN_MIN_WIDTH));
    const lower = Math.min(min, upper);
    return { lower, upper };
  }, [min, max]);

  const applyWidth = useCallback((value: number) => {
    const panel = panelRef.current;
    if (panel) panel.style.width = `${value}px`;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    dragState.current = {
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
      bounds: measureBounds(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
    event.preventDefault();
  }, [measureBounds]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state) return;
    const raw = state.startWidth + (event.clientX - state.startX);
    applyWidth(Math.min(state.bounds.upper, Math.max(state.bounds.lower, raw)));
  }, [applyWidth]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    document.body.classList.remove("is-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const panel = panelRef.current;
    if (!panel) return;
    const next = Math.round(panel.getBoundingClientRect().width);
    setWidth(next);
    persist(next);
  }, [persist]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const { lower, upper } = measureBounds();
    const current = panel.getBoundingClientRect().width;
    const delta = event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP;
    const next = Math.round(Math.min(upper, Math.max(lower, current + delta)));
    applyWidth(next);
    setWidth(next);
    persist(next);
  }, [applyWidth, measureBounds, persist]);

  const onDoubleClick = useCallback(() => {
    applyWidth(initial);
    setWidth(initial);
    persist(initial);
  }, [applyWidth, initial, persist]);

  // Own the inline width from one place. While the panels stack on small
  // screens the inline width is cleared so the responsive stylesheet's
  // `width: 100% !important` takes over untouched.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.width = isWide ? `${width}px` : "";
  }, [isWide, width]);

  const handleProps: ResizeHandleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onKeyDown,
    onDoubleClick,
  };

  return { isWide, panelRef, handleProps };
}

export function ResizeHandle({ label, ...handleProps }: ResizeHandleProps & { label: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      tabIndex={0}
      className="resize-handle"
      {...handleProps}
    >
      <span className="resize-handle-grip" aria-hidden="true" />
    </div>
  );
}
