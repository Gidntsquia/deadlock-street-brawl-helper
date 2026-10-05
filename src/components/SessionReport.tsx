import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '../../electron/sessionStore';
import type { Item } from '../types';

/** The Debug panel's session report: one row per draft of the recorded matches, with a Mark wrong button. */
export function SessionReport({ items }: { items: Item[] }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const load = useCallback(() => {
    void window.brawlAPI?.sessionList?.().then(setSessions);
  }, []);
  useEffect(load, [load]);
  const name = (id: number) => (id ? (items.find((i) => i.id === id)?.name ?? `#${id}`) : '?');
  const mark = (id: string, n: number, wrong: boolean) => void window.brawlAPI?.sessionMark?.(id, n, wrong).then(load);

  return (
    <div className="session-report" aria-label="Session report">
      <div className="row">
        <h3>Sessions</h3>
        <button className="btn" onClick={load}>
          Refresh
        </button>
      </div>
      {!sessions?.length && <div className="muted">No drafts recorded yet.</div>}
      {sessions?.map((s) => (
        <div key={s.id} className="session">
          <div className="muted">{s.id}</div>
          {s.drafts.map((d) => {
            const flags = [
              d.changes ? `changed ${d.changes}x within set` : '',
              d.dropouts ? `plates dropped ${d.dropouts}x` : '',
              d.fallback ? 'fallback' : '',
            ].filter(Boolean);
            return (
              <div key={d.n} className={d.wrong ? 'session-row wrong' : 'session-row'}>
                <b>
                  R{d.round} C{d.choice}
                </b>
                <span className="session-crops">
                  {d.crops.map((c, i) => (
                    <img key={i} src={c} alt={`Card ${i + 1}`} />
                  ))}
                </span>
                <span>Read: {d.items.map(name).join(', ')}</span>
                <span>
                  Hero: {d.hero.id || 'none'} ({d.hero.source})
                </span>
                <span>
                  Shown:{' '}
                  {d.shown.plates
                    .map(
                      (p) => `${p.itemId ? `${name(p.itemId)}` : '?'}${p.itemId === d.shown.takeId ? ' (take)' : ''}`,
                    )
                    .join(', ') || 'nothing'}
                  {d.shown.reroll ? ', re-roll' : ''}
                </span>
                <span>Advice: {d.adviceMs === null ? 'none' : `${Math.round(d.adviceMs)} ms`}</span>
                {flags.length > 0 && <span className="session-flags">{flags.join(', ')}</span>}
                <button className="btn" aria-pressed={d.wrong} onClick={() => mark(s.id, d.n, !d.wrong)}>
                  {d.wrong ? 'Marked wrong' : 'Mark wrong'}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
