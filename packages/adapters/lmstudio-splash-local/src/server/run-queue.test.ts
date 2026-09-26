import { describe, expect, it } from "vitest";
import { SplashRunQueue } from "./run-queue.js";

describe("single-instance Splash run queue", () => {
  it("admits one run and hands its slot to waiting runs in FIFO order", async () => {
    const queue = new SplashRunQueue(3);
    const first = await queue.acquire();
    const order: string[] = [];
    const second = queue.acquire(undefined, (position) => { expect(position).toBe(1); }).then((release) => {
      order.push("second");
      return release;
    });
    const third = queue.acquire(undefined, (position) => { expect(position).toBe(2); }).then((release) => {
      order.push("third");
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
    const last = await queue.acquire();
    last();
  });

  it("removes a stopped waiter without consuming the next slot", async () => {
    const queue = new SplashRunQueue(2);
    const first = await queue.acquire();
    const controller = new AbortController();
    const stopped = queue.acquire(controller.signal);
    const next = queue.acquire();
    controller.abort();
    await expect(stopped).rejects.toThrow("cancelled");
    first();
    const releaseNext = await next;
    releaseNext();
  });

  it("rejects excess work without starting another model request", async () => {
    const queue = new SplashRunQueue(1);
    const first = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire(controller.signal);
    await expect(queue.acquire()).rejects.toThrow("queue is full");
    controller.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    first();
  });

  it("times out a waiting run and clears its place", async () => {
    const queue = new SplashRunQueue(1);
    const first = await queue.acquire();
    await expect(queue.acquire(AbortSignal.timeout(10))).rejects.toThrow("timed out");
    first();
    const next = await queue.acquire();
    next();
  });
});
