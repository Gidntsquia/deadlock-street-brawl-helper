import type { BrawlApi } from '../electron/preload';

declare global {
  interface Window { brawlAPI?: BrawlApi }
}
