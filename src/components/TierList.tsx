import { useEffect, useMemo, useState } from 'react';
import type { Hero, Item } from '../types';
import { img, j } from '../data/load';
import { byGrade, heroTiers, itemTiers, type BrawlTierListData, type TierEntry } from '../brawl';
import { ItemTile } from './ItemTile';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const thousands = (n: number) => n.toLocaleString('en-US');

interface Props { heroes: Hero[]; items: Item[] }

/** S/A/B/C ladder for Street Brawl, graded from mode-wide win rate and usage (see src/brawl/tierlist.ts). */
export function TierList({ heroes, items }: Props) {
  const [data, setData] = useState<BrawlTierListData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<'heroes' | 'items'>('heroes');
  const [itemTier, setItemTier] = useState(0); // 0: every draft tier

  useEffect(() => { j<BrawlTierListData>('analytics/brawl/tier-list.json').then(setData).catch((e) => setError(String(e))); }, []);

  const heroRows = useMemo(() => (data ? heroTiers(data, heroes) : []), [data, heroes]);
  const itemRows = useMemo(() => (data ? itemTiers(data, items) : []), [data, items]);
  const tiersPresent = useMemo(() => [...new Set(itemRows.map((r) => r.subject.item_tier))].sort((a, b) => a - b), [itemRows]);
  // the two subjects render different cells, so the ladder is built per subject rather than from a union of rows
  const ladder = useMemo(() => (subject === 'heroes'
    ? byGrade(heroRows).map((g) => ({ grade: g.grade, count: g.rows.length, cells: g.rows.map((r) => <HeroCell key={r.subject.id} row={r} />) }))
    : byGrade(itemTier ? itemRows.filter((r) => r.subject.item_tier === itemTier) : itemRows)
      .map((g) => ({ grade: g.grade, count: g.rows.length, cells: g.rows.map((r) => <ItemCell key={r.subject.id} row={r} />) }))
  ), [subject, heroRows, itemRows, itemTier]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">Loading Street Brawl tier list…</div>;

  return (
    <div className="tierlist">
      <div className="panel tl-controls">
        <div className="tl-switch" role="tablist" aria-label="Tier list subject">
          <button role="tab" aria-selected={subject === 'heroes'} className={subject === 'heroes' ? 'active' : ''} onClick={() => setSubject('heroes')}>Heroes</button>
          <button role="tab" aria-selected={subject === 'items'} className={subject === 'items' ? 'active' : ''} onClick={() => setSubject('items')}>Items</button>
        </div>
        {subject === 'heroes' ? (
          <p className="muted">Every hero graded against the rest of the roster. Win rate counts for 70% of the grade, how often the hero is picked for 30%.</p>
        ) : (
          <>
            <div className="tl-filter">
              <button className={itemTier === 0 ? 'active' : ''} onClick={() => setItemTier(0)}>All tiers</button>
              {tiersPresent.map((t) => (
                <button key={t} className={itemTier === t ? 'active' : ''} onClick={() => setItemTier(t)}>Tier {ROMAN[t] ?? t}</button>
              ))}
            </div>
            <p className="muted">Each item is graded against the other items of its own draft tier, because the tier decides which round it can be offered in. Win rate counts for 70% of the grade, how often the item is drafted for 30%.</p>
          </>
        )}
      </div>

      <div className="panel tl-board">
        {ladder.map(({ grade, count, cells }) => (
          <div key={grade} className="tl-row">
            <div className={`tl-grade g${grade}`}><b>{grade}</b><small>{count}</small></div>
            {count === 0
              ? <div className="tl-empty muted">{subject === 'items' && itemTier ? `No tier ${ROMAN[itemTier] ?? itemTier} item lands here.` : 'Nothing lands here.'}</div>
              : <div className="tl-cells">{cells}</div>}
          </div>
        ))}
      </div>

      <div className="muted tl-foot">
        Percentages under each entry are its win rate and its usage, the share of hero-games it appeared in. Based on {thousands(data.hero_games)} hero-games of Street Brawl over the {data.window_days} days to {data.fetched_at.slice(0, 10)}, all ranks.
      </div>
    </div>
  );
}

function HeroCell({ row }: { row: TierEntry<Hero> }) {
  const h = row.subject;
  return (
    <div className="tl-cell" title={`${h.name}: ${pct(row.winRate, 2)} win rate, picked in ${pct(row.usage, 2)} of hero-games (${thousands(row.matches)} games)`}>
      <img className="tl-portrait" src={img(h.images.card || h.images.small)} alt="" loading="lazy" />
      <span className="tl-name">{h.name}</span>
      <span className="tl-nums"><b>{pct(row.winRate)}</b> · {pct(row.usage)}</span>
    </div>
  );
}

function ItemCell({ row }: { row: TierEntry<Item> }) {
  const i = row.subject;
  return (
    <div className="tl-cell" title={`${i.name} (tier ${ROMAN[i.item_tier] ?? i.item_tier}): ${pct(row.winRate, 2)} win rate, drafted in ${pct(row.usage, 2)} of hero-games (${thousands(row.matches)} games)`}>
      <ItemTile item={i} />
      <span className="tl-nums"><b>{pct(row.winRate)}</b> · {pct(row.usage)}</span>
    </div>
  );
}
