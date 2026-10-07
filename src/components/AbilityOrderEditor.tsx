import { AP_PER_ROUND, customOrderProblem, customRoundPoints, type CustomOrder } from '../brawl/abilities';

const COSTS = [1, 2, 5] as const;

interface Props {
  heroName: string;
  /** The hero's four ability names in bar order. */
  names: string[];
  /** The standard order, used when the player starts their own. */
  standard: CustomOrder;
  value: CustomOrder | null;
  onChange: (next: CustomOrder | null) => void;
}

/** Lets the player set the round each ability point is bought in, for one hero. The ability panel follows it. */
export function AbilityOrderEditor({ heroName, names, standard, value, onChange }: Props) {
  const problem = value ? customOrderProblem(value) : null;
  const spent = value ? customRoundPoints(value) : null;
  return (
    <details className="panel brawl-my-order">
      <summary>
        Ability order for {heroName}: {value ? (problem ? 'yours (not valid, using standard)' : 'yours') : 'standard'}
      </summary>
      {!value ? (
        <div className="row">
          <button className="btn" onClick={() => onChange([...standard])}>
            Set my own order
          </button>
        </div>
      ) : (
        <>
          <div className="muted">Pick the round you buy each upgrade in.</div>
          <table className="brawl-my-order-table">
            <thead>
              <tr>
                <th>Ability</th>
                {COSTS.map((c) => (
                  <th key={c}>{c} pt</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {names.map((name, a) => (
                <tr key={a}>
                  <td>
                    {a + 1}. {name}
                  </td>
                  {COSTS.map((c, t) => (
                    <td key={c}>
                      <select
                        aria-label={`${name} ${c} point upgrade round`}
                        value={value[a * 3 + t]}
                        onChange={(e) => onChange(value.map((r, k) => (k === a * 3 + t ? Number(e.target.value) : r)))}
                      >
                        {[1, 2, 3, 4, 5].map((r) => (
                          <option key={r} value={r}>
                            Round {r}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">{spent!.map((p, r) => `Round ${r + 1}: ${p} of ${AP_PER_ROUND[r]}`).join(', ')}</div>
          {problem && (
            <div className="brawl-problem" role="alert">
              {problem}
            </div>
          )}
          <div className="row">
            <button className="btn" onClick={() => onChange(null)}>
              Use the standard order
            </button>
          </div>
        </>
      )}
    </details>
  );
}
