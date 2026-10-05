import { firstRunLines, type Env } from '../brawl/problems';

/** The first-run check: three lines the player can see are right, and Show me, which runs the test-mode draft. */
export function FirstRun({ env, onShow, onDismiss }: { env: Env | null; onShow: () => void; onDismiss: () => void }) {
  const lines = firstRunLines(
    env ?? { found: false, width: 0, height: 0, borderless: null, black: false, denied: false, f8InUse: false },
  );
  return (
    <div className="panel brawl-firstrun" aria-label="First-run check">
      <ul>
        {lines.map((l) => (
          <li key={l.label}>
            {l.ok === null ? (
              <span>{`Set Display Mode to ${l.label} in Video settings`}</span>
            ) : (
              <span>
                <span aria-hidden="true">{l.ok ? '✓' : '○'}</span> {l.label}
                <span className="sr-only">{l.ok ? ' ok' : ' not yet'}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn primary" onClick={onShow}>
          Show me
        </button>
        <button className="btn" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
