export interface SaveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface SaveStoreOptions<T> {
  /** Exact storage key. No namespace or envelope is added. */
  key: string;
  /** Validate and preferably detach the application-owned save schema. */
  validate(value: unknown): T;
  /** Omit for page-local memory. Access to window.localStorage must itself be guarded. */
  storage?: SaveStorage;
}

/** Raw application saves, with a truthful storage-denied/quota fallback. */
export class SaveStore<T> {
  private text: string | null = null;
  private storage: SaveStorage | undefined;
  private readonly key: string;
  private readonly validate: (value: unknown) => T;
  constructor(options: SaveStoreOptions<T>) {
    if (!options || typeof options.key !== 'string' || !options.key.length) throw new TypeError('SaveStore requires a nonempty key');
    if (typeof options.validate !== 'function') throw new TypeError('SaveStore requires a validator');
    this.key = options.key;
    this.validate = options.validate;
    try { this.storage = options.storage; } catch { this.storage = undefined; }
  }
  get persistent(): boolean { return this.storage !== undefined; }
  write(value: T): void {
    const text = JSON.stringify(this.validate(value));
    if (text === undefined) throw new TypeError('Save must be JSON serializable');
    this.text = text;
    try { this.storage?.setItem(this.key, text); }
    catch { this.storage = undefined; }
  }
  read(): T | undefined {
    try { if (this.storage) this.text = this.storage.getItem(this.key); }
    catch { this.storage = undefined; }
    // Parsing/validation failures are content errors, not storage permission errors.
    return this.text === null ? undefined : this.validate(JSON.parse(this.text));
  }
}
