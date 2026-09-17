import { describe, expect, it, vi } from 'vitest';
import { log } from './log';

describe('log', () => {
  it('writes a JSON line to console[level]', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    let line: string | undefined;
    try {
      log('test', 'info', 'hello', { a: 1 });
      line = spy.mock.calls[0]?.[0] as string;
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(line!)).toMatchObject({
      tag: 'test',
      level: 'info',
      msg: 'hello',
      a: 1,
    });
  });

  it('suppresses debug logs unless opted in', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      log('test', 'debug', 'quiet');
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
