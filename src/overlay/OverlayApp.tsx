import { useEffect, useRef, useState } from 'react';
import { drawReads, type OverlayState } from '../brawl/draw';
import { cardAnchors } from '../brawl/recognise';
import { log } from '../log';

const DEMO_MS = 10_000;

const DEMO_STATE: OverlayState = {
  reads: cardAnchors(2560, 1440).map((a, k) => ({
    card: a.name,
    match: { itemId: k + 1, x: a.cx - a.icon / 2, y: a.cy - a.icon / 2, edge: a.icon, score: 1, margin: 0.5 },
    present: true,
    itemId: k + 1,
    tier: 2,
    rare: false,
    enhanced: false,
  })),
  bestId: null,
  reroll: true, // demo shows both the (dimmed) card boxes and the RE-ROLL box at once, so a single check covers both
  frameW: 2560,
  frameH: 1440,
  advice: {
    hero: 'Infernus',
    round: 2,
    choice: 1,
    reroll: { expectedBest: 2.31, currentBest: 2.0 },
    ranked: [
      { name: 'Berserker', score: 2.14, enhanced: false, usage: 0.41, winRate: 0.56 },
      { name: 'Slowing Bullets', score: 1.9, enhanced: false, usage: 0.33, winRate: 0.52 },
      { name: 'Extra Health', score: 1.6, enhanced: false, usage: 0.28, winRate: 0.5 },
    ],
    abilityLine: 'Catalyst > Afterburn Firestorm Flame Dash',
    status: 'demo mode · Ctrl+Shift+D',
  },
};

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
    if (!showing || !state.frameW || !state.frameH) return;
    drawReads(
      ctx,
      state.reads,
      state.bestId,
      c.width / state.frameW,
      c.height / state.frameH,
      state.frameW,
      state.frameH,
      state.reroll,
    );
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

  // Ctrl+Shift+D demo mode: shows a fake state (three boxes, a sample RE-ROLL box, sample advice panel)
  // for 10s so the overlay can be checked without waiting for, or being in, a real draft.
  useEffect(() => {
    const api = window.brawlAPI;
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return api.onOverlayDemo(() => {
      log('overlay', 'info', 'overlay.demo.start');
      stateRef.current = DEMO_STATE;
      setPanelState(DEMO_STATE);
      draw(DEMO_STATE);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stateRef.current = null;
        setPanelState(null);
        const c = canvasRef.current;
        c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      }, DEMO_MS);
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
                {r.enhanced ? ' (enh.)' : ''} · {(r.usage * 100).toFixed(0)}%
                {r.winRate !== null ? ` · ${(r.winRate * 100).toFixed(0)}% wins` : ''}
              </div>
            ))
          )}
          {advice.abilityLine && <div className="overlay-panel-ability">{advice.abilityLine}</div>}
          {advice.status && <div className="overlay-panel-status">{advice.status}</div>}
        </div>
      )}
    </>
  );
}
