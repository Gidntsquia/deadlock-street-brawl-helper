import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  workers: [] as {
    setParameters: ReturnType<typeof vi.fn>;
    recognize: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('tesseract.js', () => ({
  PSM: { SINGLE_LINE: 'line' },
  createWorker: vi.fn(async () => {
    const worker = {
      setParameters: vi.fn(async () => {}),
      recognize: vi.fn(async () => ({ data: { text: 'Tankbuster' } })),
      terminate: vi.fn(async () => {}),
    };
    state.workers.push(worker);
    return worker;
  }),
}));
vi.mock('sharp', () => ({
  default: () => ({
    resize() {
      return this;
    },
    png() {
      return this;
    },
    toBuffer: async () => new Uint8Array([1, 2, 3]),
  }),
}));
const crop = { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1, line: 1 };
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.workers = [];
});
afterEach(async () => {
  const ocr = await import('../ocr');
  await ocr.terminateOCR();
  vi.useRealTimers();
});
describe('shared bounded primary OCR ownership', () => {
  it('skips an obsolete queued card before encoding or recognizing and keeps the shared engine alive', async () => {
    const ocr = await import('../ocr');
    await ocr.readCardName(crop);
    const worker = state.workers[0]!;
    let finish!: (v: { data: { text: string } }) => void;
    worker.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const held = ocr.readCardName(crop);
    await flush();
    let current = true;
    const obsolete = ocr.readCardName(crop, 0, () => current);
    const rejected = expect(obsolete).rejects.toThrow('stopped');
    current = false;
    finish({ data: { text: 'Tankbuster' } });
    await held;
    await rejected;
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(await ocr.readCardName(crop)).toBe('Tankbuster');
    expect(state.workers).toHaveLength(1);
  });
  it('serializes profile configuration with recognition, sharing digit and name jobs', async () => {
    const ocr = await import('../ocr');
    const name = ocr.readCardName(crop);
    await name;
    await flush();
    let finish!: (v: { data: { text: string } }) => void;
    state.workers[0]!.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const held = ocr.readCardName(crop);
    await flush();
    const worker = state.workers[0]!;
    const digits = ocr.readHudText(crop, 'digits');
    await flush();
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    finish({ data: { text: 'Tankbuster' } });
    await held;
    await digits;
    await name;
    expect(state.workers).toHaveLength(1);
    expect(worker.setParameters.mock.calls.at(-1)?.[0]).toMatchObject({ tessedit_char_whitelist: '0123456789' });
  });
  it('bounds hung reads and detaches their engine so a new capture can continue', async () => {
    const ocr = await import('../ocr');
    ocr.warmOCR();
    await flush();
    state.workers[0]!.recognize.mockImplementation(() => new Promise(() => {}));
    const old = ocr.readCardName(crop);
    const rejected = expect(old).rejects.toThrow('timed out');
    await flush();
    vi.advanceTimersByTime(ocr.CARD_NAME_OCR_TIMEOUT_MS);
    await rejected;
    expect(state.workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(await ocr.readCardName(crop)).toBe('Tankbuster');
  });
  it('rejects late stopped recognition and never terminates the new generation engine', async () => {
    const ocr = await import('../ocr');
    ocr.warmOCR();
    await flush();
    let finish!: (v: { data: { text: string } }) => void;
    const oldWorker = state.workers[0]!;
    oldWorker.recognize.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const old = ocr.readCardName(crop);
    const rejected = expect(old).rejects.toThrow('stopped');
    await flush();
    await ocr.terminateOCR();
    await rejected;
    const fresh = ocr.readCardName(crop);
    await flush();
    const freshWorker = state.workers.at(-1)!;
    finish({ data: { text: 'old screenshot' } });
    await flush();
    expect(await fresh).toBe('Tankbuster');
    expect(freshWorker.terminate).not.toHaveBeenCalled();
  });
});
