import type { OrderStats } from './orderFetch';
import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';
import { CHANNELS } from './channels';
import type { DraftRecord, FrameShot, SessionSummary } from './sessionStore';
import type { Env, Problem } from '../src/brawl/problems';

export interface TestModeState {
  on: boolean;
  frame: string;
  frames: string[];
  message: string | null;
}

export interface CaptureState {
  wanted: boolean; // capture the game window now
  probe: boolean; // main.ts is probing for the draft screen (a real game); false: capture simply follows the window
}

const api = {
  isElectron: true as const,
  isE2E: process.env.BRAWL_E2E === '1',
  // e2e only: shortens the ability tip so a full harness run fits its time budget (the real default is 15 s).
  tipMs: process.env.BRAWL_E2E === '1' ? Number(process.env.BRAWL_TIP_MS) || 0 : 0,
  getGameRect: (): Promise<Rect | null> => ipcRenderer.invoke(CHANNELS.getGameRect),
  onGameRect: (cb: (rect: Rect | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, rect: Rect | null) => cb(rect);
    ipcRenderer.on(CHANNELS.gameRect, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.gameRect, listener);
    };
  },
  sendOverlayState: (state: OverlayState) => ipcRenderer.send(CHANNELS.overlayState, state),
  onOverlayState: (cb: (state: OverlayState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: OverlayState) => cb(state);
    ipcRenderer.on(CHANNELS.overlayState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.overlayState, listener);
    };
  },
  onCaptureDenied: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.captureDenied, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.captureDenied, listener);
    };
  },
  onProblem: (cb: (p: Problem | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: Problem | null) => cb(p);
    ipcRenderer.on(CHANNELS.problem, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.problem, listener);
    };
  },
  onEnv: (cb: (e: Env) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, e: Env) => cb(e);
    ipcRenderer.on(CHANNELS.env, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.env, listener);
    };
  },
  getEnv: (): Promise<Env | null> => ipcRenderer.invoke(CHANNELS.envGet),
  onFirstRunOpen: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.firstRunOpen, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.firstRunOpen, listener);
    };
  },
  getProblem: (): Promise<Problem | null> => ipcRenderer.invoke(CHANNELS.problemGet),
  getCaptureState: (): Promise<CaptureState> => ipcRenderer.invoke(CHANNELS.captureStateGet),
  onCaptureState: (cb: (state: CaptureState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: CaptureState) => cb(state);
    ipcRenderer.on(CHANNELS.captureState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.captureState, listener);
    };
  },
  onLoadingName: (cb: (crop: { width: number; height: number; buffer: ArrayBuffer }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, crop: { width: number; height: number; buffer: ArrayBuffer }) =>
      cb(crop);
    ipcRenderer.on(CHANNELS.loadingName, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.loadingName, listener);
    };
  },
  onRoundStart: (cb: (round: number) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, round: number) => cb(round);
    ipcRenderer.on(CHANNELS.roundStart, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.roundStart, listener);
    };
  },
  detectNow: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.detectNow),
  onDetectRun: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.detectRun, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.detectRun, listener);
    };
  },
  detectMiss: () => ipcRenderer.send(CHANNELS.detectMiss),
  saveDebugFrame: (dataUrl: string) => ipcRenderer.send(CHANNELS.saveDebugFrame, dataUrl),
  captureResult: (ok: boolean) => ipcRenderer.send(CHANNELS.captureResult, ok),
  getDetectKeyInUse: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.detectKeyGet),
  onDetectKeyState: (cb: (inUse: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, inUse: boolean) => cb(inUse);
    ipcRenderer.on(CHANNELS.detectKeyState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.detectKeyState, listener);
    };
  },
  /** The draft (and its ability tip) is over: capture stopped, go back to probing. */
  captureIdle: () => ipcRenderer.send(CHANNELS.captureIdle),
  minimizeWindow: () => ipcRenderer.send(CHANNELS.windowMinimize),
  closeWindow: () => ipcRenderer.send(CHANNELS.windowClose),
  getPlatformWarning: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.platformWarning),
  getTestMode: (): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeGet),
  setTestMode: (on: boolean): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeSet, on),
  setTestFrame: (frame: string): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeFrame, frame),
  setDebugState: (on: boolean) => ipcRenderer.send(CHANNELS.debugState, on),
  sessionFrame: (frame: FrameShot) => ipcRenderer.send(CHANNELS.sessionFrame, frame),
  sessionDraft: (rec: DraftRecord) => ipcRenderer.send(CHANNELS.sessionDraft, rec),
  orderStats: (heroId: number, order: number[]): Promise<OrderStats | null> =>
    ipcRenderer.invoke(CHANNELS.orderStats, heroId, order),
  sessionList: (): Promise<SessionSummary[]> => ipcRenderer.invoke(CHANNELS.sessionList),
  sessionMark: (matchId: string, n: number, wrong: boolean): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.sessionMark, matchId, n, wrong),
  onDebugToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.debugToggle, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.debugToggle, listener);
    };
  },
  onTestMode: (cb: (state: TestModeState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: TestModeState) => cb(state);
    ipcRenderer.on(CHANNELS.testModeState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.testModeState, listener);
    };
  },
};

export type BrawlApi = typeof api;
contextBridge.exposeInMainWorld('brawlAPI', api);
