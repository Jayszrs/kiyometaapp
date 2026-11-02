// Coalesce overlapping refresh signals, but always run one fresh read after an
// in-flight read if another refresh was requested. No data is cached here.
export function createReadRefresh(read: (signal: AbortSignal) => Promise<void>) {
  let disposed = false;
  let requested = false;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;

  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      requested = true;
      if (running) return running;
      running = (async () => {
        while (requested && !disposed) {
          requested = false;
          controller = new AbortController();
          await read(controller.signal);
        }
      })().finally(() => { running = null; controller = null; });
      return running;
    },
    dispose() {
      disposed = true;
      requested = false;
      controller?.abort();
    },
  };
}
