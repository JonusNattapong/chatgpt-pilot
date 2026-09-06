import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.js';

export class AtomicJsonStore<T extends object> {
  readonly filePath: string;
  readonly #createInitial: () => T;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, createInitial: () => T) {
    this.filePath = path.resolve(filePath);
    this.#createInitial = createInitial;
  }

  async read(): Promise<T> {
    await this.#queue;
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as T;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.#createInitial();
      if (error instanceof SyntaxError) {
        throw new ToolError('INTERNAL', `Persistent Pilot state is corrupt: ${this.filePath}`, 'Repair or remove the corrupt state file before retrying.');
      }
      throw error;
    }
  }

  async update<R>(mutate: (state: T) => R | Promise<R>): Promise<R> {
    let output!: R;
    const run = this.#queue.then(async () => {
      const state = await this.readUnlocked();
      output = await mutate(state);
      await this.writeUnlocked(state);
    });
    this.#queue = run.catch(() => undefined);
    await run;
    return output;
  }

  private async readUnlocked(): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as T;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.#createInitial();
      if (error instanceof SyntaxError) {
        throw new ToolError('INTERNAL', `Persistent Pilot state is corrupt: ${this.filePath}`, 'Repair or remove the corrupt state file before retrying.');
      }
      throw error;
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
