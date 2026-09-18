import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';
import { CHANNELS } from './channels';

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
  getPendingDemoFrame: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.getPendingDemoFrame),
  // Control window only: main.ts found no real game and wants the named demo frame (e.g. "choice1") run
  // through the real recognise -> engine path (PLAN.md item 4) -- fetched and drawn directly, never captured
  // via desktopCapturer/getUserMedia (that stays reserved for a window actually titled "Deadlock").
  onOverlayDemoStart: (cb: (frame: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, frame: string) => cb(frame);
    ipcRenderer.on(CHANNELS.overlayDemoStart, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.overlayDemoStart, listener);
    };
  },
  onOverlayDemoStop: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.overlayDemoStop, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.overlayDemoStop, listener);
    };
  },
};

export type BrawlApi = typeof api;
contextBridge.exposeInMainWorld('brawlAPI', api);
