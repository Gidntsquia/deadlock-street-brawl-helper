import type { AbilityPanelData, PointState } from '../brawl/abilities';
import { img } from '../data/load';

const COSTS = [5, 2, 1] as const; // top to bottom, matching `PanelSlot.tiers`

/** The ability upgrade panel drawn like the game's own (three point pills above each of the four abilities).
 *  Automatic targets highlight every tier held by round end. Custom orders distinguish points spent this round
 *  (`now`, bright), earlier (`done`, dark and checked), and later. Every ability is already unlocked in Street Brawl,
 *  so there is no unlock advice. Sized by the CSS variable `--u` (one reference px of the 485-px-wide in-game panel). */
export function AbilityPanel({ panel, className = '' }: { panel: AbilityPanelData; className?: string }) {
  return (
    <div
      className={`ap ${className}`}
      data-round={panel.round}
      role="img"
      aria-label={`Ability points, round ${panel.round}`}
    >
      <div className="ap-title">
        {panel.target ? `By end of round ${panel.round}` : `Round ${panel.round}: ${panel.points} points`}
      </div>
      <div className="ap-evidence">{panel.evidence}</div>
      {panel.slots.map((s) => (
        <div key={s.key} className="ap-col" data-ability={s.name}>
          {s.tiers.map((st: PointState, i) => (
            <div key={i} className={`ap-pill ap-${st}`} data-cost={COSTS[i]} data-state={st}>
              {st === 'done' ? (
                <span className="ap-check">✓</span>
              ) : (
                <>
                  <span className="ap-bolt">◆</span> {COSTS[i]}
                </>
              )}
            </div>
          ))}
          <div className="ap-ability">
            <div className="ap-circle">
              <img src={img(s.icon)} alt={s.name} />
            </div>
            <div className="ap-key">{s.key}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
