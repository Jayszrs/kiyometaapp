import { useCallback, useEffect, useRef } from "react";
import { createReadRefresh } from "./readRefresh";

export function useReadRefresh<T>(
  read: (signal: AbortSignal) => Promise<T>,
  apply: (data: T) => void,
  fail: (error: unknown) => void,
  busy: (active: boolean) => void,
) {
  const callbacks = useRef({ read, apply, fail, busy });
  callbacks.current = { read, apply, fail, busy };
  const queue = useRef<ReturnType<typeof createReadRefresh> | null>(null);

  useEffect(() => {
    const current = createReadRefresh(async signal => {
      callbacks.current.busy(true);
      try {
        const data = await callbacks.current.read(signal);
        if (!signal.aborted) callbacks.current.apply(data);
      } catch (error) {
        if (!signal.aborted) callbacks.current.fail(error);
      } finally {
        if (!signal.aborted) callbacks.current.busy(false);
      }
    });
    queue.current = current;
    void current.refresh();
    return () => {
      current.dispose();
      if (queue.current === current) queue.current = null;
    };
  }, []);

  return useCallback(() => queue.current?.refresh() ?? Promise.resolve(), []);
}
