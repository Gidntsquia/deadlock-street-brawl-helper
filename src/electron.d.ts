import type { BrawlApi } from '../electron/preload';

declare global {
  const __APP_VERSION__: string;
  interface Window {
    brawlAPI?: BrawlApi;
  }
}
