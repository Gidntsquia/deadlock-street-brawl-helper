import { useEffect, useRef, useState } from 'react';
import { drawReads, scoresFromAdvice, type DrawnRect, type OverlayState } from '../brawl/draw';
import { log } from '../log';

declare global {
  interface Window {
    __overlayDrawn?: DrawnRect[];
  }
}

/** Renders in the transparent, click-through overlay window: the highlight boxes/"TAKE" label on the
 *  canvas, plus a fixed HTML panel (bottom-left, out of the inventory grid and ability bar) mirroring the
 *  pop-out's ranked cards, RE-ROLL banner and ability line, so the player never has to alt-tab. */
export default function OverlayApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OverlayState | null>(null);
  const [panelState, setPanelState] = useState<OverlayState | null>(null);

  const draw = (state: OverlayState) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const showing = state.reads.some((r) => r.present);
    if (!showing || !state.frameW || !state.frameH) {
      if (window.brawlAPI?.isE2E) window.__overlayDrawn = [];
      return;
    }
    const drawn = drawReads(
      ctx,
      state.reads,
      state.bestId,
      c.width / state.frameW,
      c.height / state.frameH,
      state.frameW,
      state.frameH,
      state.reroll,
      scoresFromAdvice(state.advice),
    );
    // e2e-only: expose exactly what was stroked (frame px) so the harness can verify boxes without
    // re-deriving them from reads (PLAN.md item 3's boxes-<frame> check).
    if (window.brawlAPI?.isE2E) window.__overlayDrawn = drawn;
  };

  useEffect(() => {
    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      if (stateRef.current) draw(stateRef.current);
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
      setPanelState(state);
      draw(state);
    });
  }, []);

  const advice = panelState?.advice ?? null;

  return (
    <>
      <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }} />
      {advice && (
        <div className="overlay-panel">
          <div className="overlay-panel-head">
            {advice.hero} · round {advice.round}, choice {advice.choice}
          </div>
          {advice.reroll ? (
            <div className="overlay-panel-reroll">
              RE-ROLL — expected {advice.reroll.expectedBest.toFixed(2)} vs {advice.reroll.currentBest.toFixed(2)}
            </div>
          ) : (
            advice.ranked.map((r, k) => (
              <div key={r.name} className="overlay-panel-card">
                {k === 0 ? 'TAKE' : `#${k + 1}`} {r.name}
                {r.enhanced ? ' (enh.)' : ''} · {r.score.toFixed(2)} · {(r.usage * 100).toFixed(0)}%
                {r.winRate !== null ? ` · ${(r.winRate * 100).toFixed(0)}% wins` : ''}
              </div>
            ))
          )}
          {advice.abilityNext && !advice.onShop && (
            <div className="overlay-panel-ability-next">upgrade: {advice.abilityNext}</div>
          )}
          {advice.status && <div className="overlay-panel-status">{advice.status}</div>}
        </div>
      )}
    </>
  );
}
