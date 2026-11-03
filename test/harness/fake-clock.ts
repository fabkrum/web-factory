import type { Clock } from "../../src/clock.ts";

/** A clock whose sleeps return at once and move its time on by what they slept. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  #now: number;

  constructor(start = new Date("2026-10-22T22:00:00Z")) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
  }
}
