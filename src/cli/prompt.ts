import crypto from 'node:crypto';
import readline from 'node:readline/promises';

// Thin wrapper over readline/promises. `--yes` runs the whole of setup without
// a terminal, so every prompt has to be answerable from its default.

interface MutableInterface {
  output?: { write(chunk: string): void };
  _writeToOutput?(text: string): void;
}

export class Prompter {
  private rl: readline.Interface | null = null;
  private muted = false;

  constructor(private readonly assumeYes = false) {}

  private iface(): readline.Interface {
    if (this.rl) return this.rl;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });
    const mutable = rl as unknown as MutableInterface;
    const write = mutable._writeToOutput?.bind(rl);
    mutable._writeToOutput = (text: string) => {
      if (!this.muted) write?.(text);
    };
    this.rl = rl;
    return rl;
  }

  get interactive(): boolean {
    return !this.assumeYes && Boolean(process.stdin.isTTY);
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  async ask(question: string, fallback = ''): Promise<string> {
    if (!this.interactive) return fallback;
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (
      await this.iface().question(`${question}${suffix}: `)
    ).trim();
    return answer || fallback;
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    if (!this.interactive) return fallback;
    const hint = fallback ? 'Y/n' : 'y/N';
    const answer = (await this.iface().question(`${question} [${hint}] `))
      .trim()
      .toLowerCase();
    if (!answer) return fallback;
    return answer === 'y' || answer === 'yes';
  }

  /** Reads without echoing when the terminal allows it. */
  async secret(question: string): Promise<string> {
    if (!this.interactive) return '';
    const rl = this.iface();
    if (!process.stdin.isTTY) {
      console.log('(input will be visible: this is not a terminal)');
      return (await rl.question(`${question}: `)).trim();
    }
    process.stdout.write(`${question}: `);
    this.muted = true;
    try {
      const answer = await rl.question('');
      return answer.trim();
    } finally {
      this.muted = false;
      process.stdout.write('\n');
    }
  }
}

export function generatePassword(): string {
  return crypto.randomBytes(15).toString('base64url');
}
