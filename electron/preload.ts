import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';
import { CHANNELS } from './channels';

const api = {
  isElectron: true as const,
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
  onOverlayDemo: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.overlayDemo, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.overlayDemo, listener);
    };
  },
};

export type BrawlApi = typeof api;
contextBridge.exposeInMainWorld('brawlAPI', api);
