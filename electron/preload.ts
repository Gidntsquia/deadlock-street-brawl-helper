import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';

const api = {
  isElectron: true as const,
  getGameRect: (): Promise<Rect | null> => ipcRenderer.invoke('get-game-rect'),
  onGameRect: (cb: (rect: Rect | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, rect: Rect | null) => cb(rect);
    ipcRenderer.on('game-rect', listener);
    return () => {
      ipcRenderer.removeListener('game-rect', listener);
    };
  },
  sendOverlayState: (state: OverlayState) => ipcRenderer.send('overlay-state', state),
  onOverlayState: (cb: (state: OverlayState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: OverlayState) => cb(state);
    ipcRenderer.on('overlay-state', listener);
    return () => {
      ipcRenderer.removeListener('overlay-state', listener);
    };
  },
};

export type BrawlApi = typeof api;
contextBridge.exposeInMainWorld('brawlAPI', api);
