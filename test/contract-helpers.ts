// From edspencer/cli-contract test/helpers.ts @ 0.2; local changes: imports server/contract/, not reference/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OutputStream } from '../server/contract/output.ts';

/** A stream that remembers what was written. */
export function capture(isTTY = false): OutputStream & { text: string } {
  const s = {
    text: '',
    isTTY,
    write(chunk: string) {
      s.text += chunk;
      return true;
    },
  };
  return s;
}

export function tempDir(prefix = 'cli-contract-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
