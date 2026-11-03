import type { CruxSource, FieldData } from "../../src/crux.ts";

/** The Chrome UX Report as a test sets it: data per origin, or none for a Site with too few Visitors. */
export class FakeCrux implements CruxSource {
  readonly #data = new Map<string, FieldData>();
  readonly asked: string[] = [];

  /** What the report holds for an origin from now on. */
  set(origin: string, data: FieldData): void {
    this.#data.set(origin, data);
  }

  async query(origin: string): Promise<FieldData | undefined> {
    this.asked.push(origin);
    return this.#data.get(origin);
  }
}
