import { useState } from 'react';
import {
  AP_PER_ROUND,
  customOrderProblem,
  customPartialProblem,
  customPointsLeft,
  NOT_BOUGHT,
  type CustomOrder,
} from '../brawl/abilities';
import { img } from '../data/load';

/** Pills top to bottom as the game (and `AbilityPanel`) draws them: tier 3 (5 points), tier 2 (2), tier 1 (1). */
const TIERS = [3, 2, 1] as const;
const COST = { 1: 1, 2: 2, 3: 5 } as const;
const ROUNDS = [1, 2, 3, 4, 5] as const;

export interface EditorAbility {
  name: string;
  /** App-relative image path. */
  icon: string;
  /** Key cap under the ability (Q, E, R, F). */
  key: string;
}

interface Props {
  heroName: string;
  /** The hero's four abilities in bar order. */
  abilities: EditorAbility[];
  /** The standard order, used when the player starts their own. */
  standard: CustomOrder;
  /** `<n> matches, <w>% win rate` of the default (best blended) order, or `No reliable order`. */
  defaultEvidence: string;
  value: CustomOrder | null;
  onChange: (next: CustomOrder | null) => void;
  /** The round selected when the editor opens (the game's current round). */
  round?: number;
}

/** The player's own ability order for one hero, set on a picture of the game's ability upgrade panel (the same
 *  layout as `AbilityPanel`): pick a round, then click a pill to buy it in that round or click a bought pill to sell it.
 *  Pills are bought bottom up (the 2 point pill needs the 1 point pill in the same or an earlier round), and a round
 *  cannot spend more than it and the earlier rounds hand out. The ability panel after each draft follows the order. */
export function AbilityOrderEditor({ heroName, abilities, standard, defaultEvidence, value, onChange, round }: Props) {
  const [sel, setSel] = useState(round && round >= 1 && round <= 5 ? round : 1);
  const [refused, setRefused] = useState<string | null>(null);
  const order = value ?? standard;
  const problem = value ? customOrderProblem(value) : null;
  const left = customPointsLeft(order, sel);

  const click = (a: number, tier: 1 | 2 | 3) => {
    const k = a * 3 + tier - 1;
    const next = [...order];
    const name = abilities[a]?.name ?? `Ability ${a + 1}`;
    if (next[k] !== NOT_BOUGHT) {
      // sell it, and the pills above it on that ability (they need it)
      for (let t = tier; t <= 3; t++) next[a * 3 + t - 1] = NOT_BOUGHT;
    } else {
      const below = tier > 1 ? next[k - 1]! : 1;
      if (below === NOT_BOUGHT || below > sel) {
        setRefused(
          `${name}: buy the ${COST[(tier - 1) as 1 | 2]} point upgrade first, in round ${sel} or an earlier one.`,
        );
        return;
      }
      next[k] = sel;
      const why = customPartialProblem(next);
      if (why) {
        setRefused(why);
        return;
      }
    }
    setRefused(null);
    onChange(next);
  };

  return (
    <details className="panel brawl-my-order">
      <summary>
        Ability order for {heroName}: {value ? (problem ? 'yours (not valid, using standard)' : 'yours') : 'standard'}
      </summary>
      <div className="muted">
        Pick a round, then click a point to buy it in that round. Click a bought point to sell it.
      </div>
      <div className="ape-rounds" role="group" aria-label="Round to buy in">
        {ROUNDS.map((r) => (
          <button
            key={r}
            className={`btn ape-round${r === sel ? ' active' : ''}`}
            aria-pressed={r === sel}
            onClick={() => {
              setSel(r);
              setRefused(null);
            }}
          >
            Round {r}
          </button>
        ))}
      </div>
      <div className="ap ap-editor" data-round={sel}>
        <div className="ap-title">
          Round {sel}: {AP_PER_ROUND[sel - 1]} points, {left} left
        </div>
        <div className="ap-evidence">{value ? 'Your order' : `Default order: ${defaultEvidence}`}</div>
        {abilities.slice(0, 4).map((ab, a) => (
          <div key={a} className="ap-col" data-ability={ab.name}>
            {TIERS.map((tier) => {
              const at = order[a * 3 + tier - 1]!;
              const state = at === NOT_BOUGHT ? 'later' : at < sel ? 'done' : at === sel ? 'now' : 'booked';
              return (
                <button
                  key={tier}
                  type="button"
                  className={`ap-pill ap-${state}`}
                  data-cost={COST[tier]}
                  data-state={state}
                  aria-label={`${ab.name} ${COST[tier]} point upgrade, ${at === NOT_BOUGHT ? 'not bought' : `round ${at}`}`}
                  onClick={() => click(a, tier)}
                >
                  {state === 'done' ? <span className="ap-check">✓</span> : <span className="ap-bolt">◆</span>}
                  {state !== 'done' && ` ${COST[tier]}`}
                  {at !== NOT_BOUGHT && <span className="ape-at">R{at}</span>}
                </button>
              );
            })}
            <div className="ap-ability">
              <div className="ap-circle">{ab.icon && <img src={img(ab.icon)} alt={ab.name} />}</div>
              <div className="ap-key">{ab.key}</div>
            </div>
          </div>
        ))}
      </div>
      {(refused ?? problem) && (
        <div className="brawl-problem" role="alert">
          {refused ?? problem}
        </div>
      )}
      <div className="row">
        <button
          className="btn"
          onClick={() => {
            setRefused(null);
            onChange(null);
          }}
        >
          Reset to default order
        </button>
        <button
          className="btn"
          onClick={() => {
            setRefused(null);
            onChange(Array(12).fill(NOT_BOUGHT));
          }}
        >
          Start from empty
        </button>
      </div>
    </details>
  );
}
