// The app speaks plainly: no exclamation marks, emoji, em dashes, arrows or middle dots in what it says. Scans the code
// under src/ and electron/ (comments and tests left out) and the README. The wiki lives outside the repo and is
// checked by hand.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === '__tests__' || n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = [...walk('src'), ...walk('electron')].filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|d)\.ts$/.test(f) && !f.endsWith('.test.tsx'),
);
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
const BANNED = /[—–→←·]|\p{Extended_Pictographic}/u;

describe('plain strings', () => {
  it('has no em dashes, arrows, middle dots or emoji in the code', () => {
    const bad = files.flatMap((f) =>
      stripComments(readFileSync(f, 'utf8'))
        .split('\n')
        .map((l, i) => (BANNED.test(l) ? `${f}:${i + 1}: ${l.trim()}` : ''))
        .filter(Boolean),
    );
    expect(bad).toEqual([]);
  });
  it('has no exclamation marks in strings or text', () => {
    const bad: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8')).replace(/\$\{[^}]*\}/g, '');
      for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1|>([^<>{}\n]+)</g)) {
        const text = m[2] ?? m[3] ?? '';
        if (/[A-Za-z0-9.)]!(\s|$)/.test(text)) bad.push(`${f}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('has none of them in the README', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme.split('\n').filter((l) => BANNED.test(l))).toEqual([]);
    expect(readme.split('\n').filter((l) => /[A-Za-z]!(\s|$)/.test(l.replace(/\[.*?\]\(.*?\)|`.*?`/g, '')))).toEqual(
      [],
    );
  });
});
