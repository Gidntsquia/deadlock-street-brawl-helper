import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Maps recording file names (the `file` of each stretch in labels.json) to paths on disk. Each argument is one of:
 * a directory holding the recordings, `name.mkv=<path>`, or a single video file path (found by its base name).
 * Throws when a needed recording is missing, naming it.
 */
export function resolveVideos(args: string[], needed: string[]): Map<string, string> {
  const dirs: string[] = [];
  const map = new Map<string, string>();
  for (const a of args) {
    const eq = a.indexOf('.mkv=');
    if (eq > 0) map.set(a.slice(0, eq + 4), a.slice(eq + 5));
    else if (existsSync(a) && statSync(a).isDirectory()) dirs.push(a);
    else map.set(path.basename(a), a);
  }
  const out = new Map<string, string>();
  for (const name of new Set(needed)) {
    const hit = map.get(name) ?? dirs.map((d) => path.join(d, name)).find((f) => existsSync(f));
    if (!hit || !existsSync(hit)) throw new Error(`recording not found: ${name} (give its directory or name=<path>)`);
    out.set(name, hit);
  }
  return out;
}

/** `--only s3,s7` as a set of stretch ids, or null for all. */
export function onlyIds(args: string[]): Set<string> | null {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? new Set(args[i + 1]!.split(',')) : null;
}
