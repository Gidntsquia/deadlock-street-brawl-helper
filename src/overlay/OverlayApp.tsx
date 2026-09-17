import { useEffect, useRef } from 'react';
import { drawReads, type OverlayState } from '../brawl/draw';
import { log } from '../log';

/** Renders in the transparent, click-through overlay window: just the highlight boxes and "TAKE" label,
 *  drawn at the overlay window's own size (which main.ts keeps pinned to the game window's rect). */
export default function OverlayApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OverlayState | null>(null);

  useEffect(() => {
    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const api = window.brawlAPI;
    if (!api) {
      log('overlay', 'warn', 'brawlAPI missing: not running under Electron');
      return;
    }
    return api.onOverlayState((state) => {
      stateRef.current = state;
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      const showing = state.reads.some((r) => r.present);
      if (!showing || !state.frameW || !state.frameH) return;
      drawReads(ctx, state.reads, state.bestId, c.width / state.frameW, c.height / state.frameH);
    });
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }} />;
}
