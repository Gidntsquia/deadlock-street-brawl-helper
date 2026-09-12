import { useEffect, useState } from 'react';
import type { Ability, Hero, Item } from './types';
import { img, loadCore, type Manifest } from './data/load';
import { BrawlView } from './components/BrawlView';
import { TierList } from './components/TierList';

const INFERNUS = 1;

const TABS = [{ key: 'advisor', label: 'Draft advisor' }, { key: 'tiers', label: 'Street Brawl Tier List' }] as const;
type Tab = (typeof TABS)[number]['key'];

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [heroId, setHeroId] = useState(INFERNUS);
  const [tab, setTab] = useState<Tab>('advisor');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCore().then(([i, h, a, m]) => { setItems(i); setHeroes(h); setAbilities(a); setManifest(m); }).catch((e) => setError(String(e)));
  }, []);

  const hero = heroes.find((h) => h.id === heroId);

  if (error) return <div className="error">{error}</div>;
  if (!hero) return <div className="loading">Loading snapshots…</div>;

  return (
    <>
      <header className="app-header">
        {tab === 'advisor' && <img src={img(hero.images.small)} alt="" />}
        <div>
          <h1>{tab === 'advisor' ? `${hero.name} Street Brawl` : 'Street Brawl Tier List'}</h1>
          <div className="sub">{tab === 'advisor' ? 'Deadlock Street Brawl Helper' : 'Heroes and items graded by win rate and usage'}, data fetched {manifest?.fetched_at.slice(0, 10)}</div>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="View">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </nav>
      {tab === 'advisor' ? (
        <>
          <div className="hero-strip" role="tablist" aria-label="Hero">
            {heroes.map((h) => (
              <button key={h.id} className={`hero-chip ${h.id === heroId ? 'active' : ''}`} onClick={() => setHeroId(h.id)} role="tab" aria-selected={h.id === heroId}>
                <img src={img(h.images.small)} alt="" loading="lazy" /><span>{h.name}</span>
              </button>
            ))}
          </div>
          <select className="hero-select" value={heroId} onChange={(e) => setHeroId(Number(e.target.value))} aria-label="Select hero">
            {heroes.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={setHeroId} />
        </>
      ) : (
        <TierList heroes={heroes} items={items} />
      )}
      <footer>Data: deadlock-api.com (aggregate analytics, assets). See README for the scoring function.</footer>
    </>
  );
}
