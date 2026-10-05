import type { OverlayAdvice } from '../brawl/draw';
import { RerollCounterLabel } from './RerollCounterLabel';
import { availableReroll } from './overlaySettings';

export function OverlayAdvicePanel({ advice }: { advice: OverlayAdvice }) {
  if (advice.detail === 'off') return null;
  if (advice.ranked.length === 0)
    return (
      <div className="overlay-panel overlay-panel-detailed" role="status">
        Reading
      </div>
    );
  const reroll = availableReroll(advice.reroll, advice.rerollsRemaining);
  return (
    <div className="overlay-panel overlay-panel-detailed">
      <div className="overlay-panel-head">
        {advice.hero}, round {advice.round}, choice {advice.choice}
      </div>
      <RerollCounterLabel remaining={advice.rerollsRemaining} />
      {reroll && (
        <div className="overlay-panel-reroll">
          RE-ROLL, expected {reroll.expectedBest.toFixed(2)} vs {reroll.currentBest.toFixed(2)}
        </div>
      )}
      {advice.ranked.map((r, k) => (
        <div key={`slot-${k}`} className="overlay-panel-card">
          {k === 0 ? (reroll ? 'BEST NOW' : 'TAKE') : `#${k + 1}`} {r.name}
          {r.enhanced ? ' (enh.)' : ''}, {r.score.toFixed(2)}, {(r.usage * 100).toFixed(0)}% picks
          {r.winRate !== null ? `, ${(r.winRate * 100).toFixed(0)}% wins` : ''}
        </div>
      ))}
      {advice.confidence && <div className="overlay-panel-status">{advice.confidence}</div>}
      {advice.status && <div className="overlay-panel-status">{advice.status}</div>}
    </div>
  );
}
