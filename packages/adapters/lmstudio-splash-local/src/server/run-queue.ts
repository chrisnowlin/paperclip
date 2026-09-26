interface WaitingRun {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

function waitStopped(signal?: AbortSignal): Error {
  return signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new Error("Waiting for the local Splash model timed out.")
    : new Error("Splash run was cancelled while waiting for the model.");
}

/** Serializes complete local Splash runs within the V2 server process. */
export class SplashRunQueue {
  private active = false;
  private readonly waiting: WaitingRun[] = [];

  constructor(private readonly maxWaiting = 3) {}

  acquire(signal?: AbortSignal, onQueued?: (position: number) => void): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(waitStopped(signal));
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new Error("The local Splash queue is full; retry this task after another run finishes."));
    }
    return new Promise<() => void>((resolve, reject) => {
      const run: WaitingRun = {
        resolve, reject, signal,
        onAbort: () => {
          const index = this.waiting.indexOf(run);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", run.onAbort);
          reject(waitStopped(signal));
        },
      };
      this.waiting.push(run);
      signal?.addEventListener("abort", run.onAbort, { once: true });
      try { onQueued?.(this.waiting.length); }
      catch (error) {
        const index = this.waiting.indexOf(run);
        if (index >= 0) this.waiting.splice(index, 1);
        signal?.removeEventListener("abort", run.onAbort);
        reject(error instanceof Error ? error : new Error("Could not queue Splash run."));
      }
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const next = this.waiting.shift();
        if (!next) { this.active = false; return; }
        next.signal?.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          next.reject(waitStopped(next.signal));
          continue;
        }
        next.resolve(this.releaseOnce());
        return;
      }
    };
  }
}

export const splashRunQueue = new SplashRunQueue();
