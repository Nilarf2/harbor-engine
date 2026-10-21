// Generalized from Nilarf2/dragon-raja-grand-escape (MIT), © 2026 Nilarf2.
export type StoryYield = number | (() => boolean);
export interface StoryBeat { id: string; run(): Generator<StoryYield, void, unknown> }

/** Application-owned story commands; stable checkpoints and generator cleanup. */
export class StoryRunner {
  private iterator?: Generator<StoryYield, void, unknown>;
  private wait = 0;
  private predicate?: () => boolean;
  private index = -1;
  constructor(readonly beats: StoryBeat[], private changed: () => void = () => {}, private completed: () => void = () => {}) {
    if (!beats.length || beats.some(beat => typeof beat.id !== 'string' || !beat.id || typeof beat.run !== 'function') || new Set(beats.map(beat => beat.id)).size !== beats.length) {
      throw new TypeError('Story needs nonempty unique beat IDs and generators');
    }
  }
  get active(): boolean { return this.iterator !== undefined; }
  get checkpoint(): string | undefined { return this.beats[this.index]?.id; }
  start(id = this.beats[0].id): void {
    const index = this.beats.findIndex(beat => beat.id === id);
    if (index < 0) throw new Error(`Unknown story beat: ${id}`);
    this.stop(); this.index = index; this.begin();
  }
  private begin(): void {
    this.wait = 0; this.predicate = undefined; this.changed(); this.iterator = this.beats[this.index].run();
  }
  next(): void {
    if (!this.iterator) return;
    const iterator = this.iterator; this.iterator = undefined;
    iterator.return();
    if (++this.index >= this.beats.length) { this.completed(); return; }
    this.begin();
  }
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) throw new TypeError('Story timestep must be finite and nonnegative');
    if (!this.iterator) return;
    if ((this.wait -= dt) > 0) return;
    if (this.predicate && !this.predicate()) return;
    this.predicate = undefined;
    const step = this.iterator.next();
    if (step.done) this.next();
    else if (typeof step.value === 'number') {
      if (!Number.isFinite(step.value)) throw new TypeError('Story wait must be finite');
      this.wait = Math.max(0, step.value);
    } else if (typeof step.value === 'function') this.predicate = step.value;
    else throw new TypeError('Story must yield seconds or a predicate');
  }
  stop(): void {
    const iterator = this.iterator; this.iterator = undefined; this.wait = 0; this.predicate = undefined;
    iterator?.return();
  }
}
