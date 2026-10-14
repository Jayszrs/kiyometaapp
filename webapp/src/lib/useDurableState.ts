import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useAuth } from "./auth";
import { readRecovery, writeRecovery } from "./recoveryStorage";

export function useDurableState<T>(slot: string, initial: T | (() => T), replaceStored = false) {
  const { profile } = useAuth();
  const [state, setState] = useState<T>(() => {
    const restored = replaceStored ? undefined : readRecovery<T>(profile.id, slot);
    return restored !== undefined ? restored : typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const current = useRef(state);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setDurable = useCallback((update: SetStateAction<T>) => {
    if (!mounted.current) return;
    const next = typeof update === "function" ? (update as (previous: T) => T)(current.current) : update;
    current.current = next;
    // Keep typing usable when storage fails; the persistent warning tells the
    // operator this draft cannot survive closing. Submissions fail closed.
    try { writeRecovery(profile.id, slot, next); } catch { /* global warning */ }
    setState(next);
  }, [profile.id, slot]);
  useEffect(() => {
    const acknowledge = (event: Event) => {
      const { owner, submitted, saved } = (event as CustomEvent).detail;
      if (owner !== profile.id) return;
      if ((slot === "entry-new" || slot === "entry-selection") &&
          readRecovery<{id: string}>(owner, "entry-form")?.id === saved.id) {
        setDurable((slot === "entry-new" ? false : saved.id) as T);
        return;
      }
      const draft = current.current as T & { id?: string; version?: number };
      if (!draft || draft.id !== submitted.id) return;
      // Preserve edits made after pressing Submit; only advance their base
      // version when acknowledging this account's own queued write.
      if (draft.version !== submitted.version) return;
      setDurable(JSON.stringify(draft) === JSON.stringify(submitted) ? saved : { ...draft, version: saved.version });
    };
    window.addEventListener("kiyometa-order-saved", acknowledge);
    return () => window.removeEventListener("kiyometa-order-saved", acknowledge);
  }, [profile.id, setDurable]);
  return [state, setDurable] as const;
}
