/** Snapshot based undo stack. Each entry is a serialized scene. */
export class History {
  private readonly past: string[] = [];
  private readonly future: string[] = [];
  private present: string;

  constructor(initial: string, private readonly limit = 200) {
    this.present = initial;
  }

  /** Records a new state. Returns false when nothing changed. */
  push(state: string): boolean {
    if (state === this.present) return false;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = state;
    this.future.length = 0;
    return true;
  }

  /** Replaces the current state without creating an undo step (e.g. after loading a scene). */
  reset(state: string): void {
    this.past.length = 0;
    this.future.length = 0;
    this.present = state;
  }

  undo(): string | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(this.present);
    this.present = previous;
    return previous;
  }

  redo(): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
