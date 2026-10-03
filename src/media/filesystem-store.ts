/**
 * Media on the local disk, for development and air-gapped installs. Node only.
 * Port of `genai_otel/media/stores/filesystem.py`.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MediaStore } from './offload';

export class FilesystemStore implements MediaStore {
  readonly root: string;

  constructor(root: string, bucket = 'genai-otel-media') {
    this.root = resolve(join(root, bucket));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Where `key` goes under the root; a key that would leave it is refused. */
  private target(key: string): string {
    if (isAbsolute(key) || /^[a-zA-Z]:/.test(key) || key.startsWith('/') || key.startsWith('\\')) {
      throw new Error(`Unsafe media key (absolute path not allowed): '${key}'`);
    }
    const target = resolve(this.root, key);
    const inside = relative(this.root, target);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Unsafe media key escapes store root: '${key}'`);
    return target;
  }

  put(data: Uint8Array, options: { key: string; mimeType: string }): string {
    const target = this.target(options.key);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data);
    try {
      chmodSync(target, 0o600);
    } catch {
      // not every filesystem has modes
    }
    return pathToFileURL(target).href;
  }
}
