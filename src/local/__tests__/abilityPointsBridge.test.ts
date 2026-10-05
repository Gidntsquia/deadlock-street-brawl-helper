import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbilityPointsBridge } from '../abilityPointsBridge';
import { AbilityPointsReader } from '../abilityPointsReader';
import type { WorkerIn } from '../../brawl/worker';
import type { RGBImage } from '../../brawl/recognise';

const glyph = () => ({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) });
const make = () => {
  const messages: WorkerIn[] = [];
  const bridge = new AbilityPointsBridge((message) => messages.push(message), 7);
  const jobs = () =>
    messages.filter(
      (message): message is Extract<WorkerIn, { type: 'abilityPoints' }> => message.type === 'abilityPoints',
    );
  const reply = (index: number, text: string, confidence = 90) => {
    const job = jobs()[index]!;
    bridge.receive({
      type: 'abilityPoints',
      captureEpoch: job.captureEpoch,
      tipEpoch: job.tipEpoch,
      sample: job.sample,
      text,
      confidence,
    });
  };
  return { bridge, messages, jobs, reply };
};
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('HUD points worker bridge', () => {
  it('owns one physical request and caches a completed unknown ink crop until the next tip', async () => {
    const { bridge, jobs, reply } = make();
    const first = bridge.request(glyph());
    const concurrent = bridge.request(glyph());
    expect(jobs()).toHaveLength(1);
    reply(0, 'not read');
    expect(await first).toEqual({ text: '', confidence: 0 });
    expect(await concurrent).toEqual({ text: '', confidence: 0 });
    for (let index = 0; index < 8; index++) expect((await bridge.request(glyph())).text).toBe('');
    expect(jobs()).toHaveLength(1);
    bridge.reset();
    const next = bridge.request(glyph());
    expect(jobs()).toHaveLength(2);
    reply(0, '0'); // A cancelled prior-tip response cannot turn unread into zero.
    reply(1, '6');
    expect((await next).text).toBe('6');
    bridge.dispose();
  });

  it('cancels a timed-out worker sample and never queues replacements for unchanged unread ink', async () => {
    vi.useFakeTimers();
    const { bridge, messages, jobs, reply } = make();
    const first = bridge.request(glyph());
    await vi.advanceTimersByTimeAsync(1500);
    expect((await first).text).toBe('');
    expect(messages.filter((message) => message.type === 'abilityPointsCancel')).toHaveLength(1);
    reply(0, '0');
    expect((await bridge.request(glyph())).text).toBe('');
    expect(jobs()).toHaveLength(1);
    const changed = glyph();
    changed.data[0] = 255;
    const next = bridge.request(changed);
    expect(jobs()).toHaveLength(2);
    expect(jobs()[1]!.tipEpoch).toBeGreaterThan(jobs()[0]!.tipEpoch);
    reply(0, '64');
    reply(1, '12');
    expect((await next).text).toBe('12');
    bridge.dispose();
  });

  it('copies source ink and only a fresh reader observation can provide the second confirmation', async () => {
    const { bridge, jobs, reply } = make();
    const source = glyph();
    const emit = vi.fn();
    const image: RGBImage = { width: 1, height: 1, channels: 4, data: new Uint8Array(4) };
    const reader = new AbilityPointsReader(async () => {
      const result = await bridge.request(source);
      return /^[0-9]{1,2}$/.test(result.text) ? Number(result.text) : null;
    });
    reader.poll(image, 0, emit);
    source.data[0] = 255;
    expect(new Uint8Array(jobs()[0]!.buffer)[0]).toBe(0);
    reader.poll(image, 1000, emit);
    expect(jobs()).toHaveLength(1);
    reply(0, '6', NaN);
    await flush();
    expect(emit).not.toHaveBeenCalled();
    source.data[0] = 0;
    reader.poll(image, 2000, emit);
    await flush();
    expect(jobs()).toHaveLength(1);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(6);
    bridge.dispose();
  });

  it('rejects another capture and cancels the pending owner when capture closes', async () => {
    const { bridge, jobs, messages, reply } = make();
    const first = bridge.request(glyph());
    const job = jobs()[0]!;
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    bridge.receive({ ...job, type: 'abilityPoints', captureEpoch: 8, text: '0', confidence: 90 });
    await flush();
    expect(settled).toBe(false);
    bridge.dispose();
    expect((await first).text).toBe('');
    expect(messages.filter((message) => message.type === 'abilityPointsCancel')).toHaveLength(1);
    reply(0, '0');
    expect((await bridge.request(glyph())).text).toBe('');
    expect(jobs()).toHaveLength(1);
  });
});
