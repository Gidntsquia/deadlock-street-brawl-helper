import { useEffect, useRef, useState } from 'react';
import { drawReads, overlayHasContent, scoresFromAdvice, type DrawnRect, type OverlayState } from '../brawl/draw';
import { AbilityPanel } from '../components/AbilityPanel';
import { log } from '../log';

declare global {
  interface Window {
    __overlayDrawn?: DrawnRect[];
  }
}

/** Renders in the transparent, click-through overlay window: the highlight circles/scores on the canvas, plus a
 *  fixed HTML panel (bottom-left, out of the inventory grid and ability bar) mirroring the pop-out's ranked cards
 *  and RE-ROLL banner, so the player never has to alt-tab. It draws nothing unless the item draft screen is on
 *  the frame or the ability panel (the standard point allocation for the round, ~15 s after the draft closes) is up. */
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
    if (!overlayHasContent(state) || !state.frameW || !state.frameH) {
      if (window.brawlAPI?.isE2E) window.__overlayDrawn = [];
      return;
    }
    const sx = c.width / state.frameW,
      sy = c.height / state.frameH;
    const drawn: DrawnRect[] = [];
    if (state.draft)
      drawn.push(
        ...drawReads(
          ctx,
          state.reads,
          state.bestId,
          sx,
          sy,
          state.frameW,
          state.frameH,
          state.reroll,
          scoresFromAdvice(state.advice),
          state.rerollRect ?? null,
        ),
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

  const advice = panelState?.draft ? panelState.advice : null;
  const abilityPanel = panelState && !panelState.draft ? panelState.panel : null;

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
          {advice.status && <div className="overlay-panel-status">{advice.status}</div>}
        </div>
      )}
      {abilityPanel && <AbilityPanel panel={abilityPanel} className="overlay-ap" />}
    </>
  );
}
