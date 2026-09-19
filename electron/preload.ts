import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';
import { CHANNELS } from './channels';

export interface TestModeState {
  on: boolean;
  frame: string;
  frames: string[];
  message: string | null;
}

const api = {
  isElectron: true as const,
  isE2E: process.env.BRAWL_E2E === '1',
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
  getPlatformWarning: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.platformWarning),
  getTestMode: (): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeGet),
  setTestMode: (on: boolean): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeSet, on),
  setTestFrame: (frame: string): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeFrame, frame),
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
