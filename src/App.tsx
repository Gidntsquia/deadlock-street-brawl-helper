import { useEffect, useState } from 'react';
import type { Ability, Hero, Item } from './types';
import { img, loadCore, type Manifest } from './data/load';
import { BrawlView } from './components/BrawlView';
import { TierList } from './components/TierList';
import { usePersisted, isNumber, isString } from './hooks/usePersisted';

const INFERNUS = 1;

const TABS = [
  { key: 'advisor', label: 'Draft advisor' },
  { key: 'tiers', label: 'Street Brawl Tier List' },
] as const;
type Tab = (typeof TABS)[number]['key'];
const isTab = (v: unknown): v is Tab => isString(v) && TABS.some((t) => t.key === v);

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [heroId, setHeroId] = usePersisted('heroId', isNumber, INFERNUS);
  const [tab, setTab] = usePersisted<Tab>('tab', isTab, 'advisor');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadCore()
      .then(([i, h, a, m]) => {
        setItems(i);
        setHeroes(h);
        setAbilities(a);
        setManifest(m);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const hero = heroes.find((h) => h.id === heroId);

  if (error) return <div className="error">{error}</div>;
  if (!hero) return <div className="loading">Loading snapshots…</div>;

  const fetchedAt = manifest?.brawl?.fetched_at ?? manifest?.fetched_at;
  const fetchedDate = fetchedAt?.slice(0, 10);
  const ageDays = fetchedAt ? Math.floor((Date.now() - Date.parse(fetchedAt)) / 86400000) : null;
  const stale = ageDays !== null && ageDays > 14;

  return (
    <>
      <header className="app-header">
        {tab === 'advisor' && <img src={img(hero.images.small)} alt="" />}
        <div>
          <h1>{tab === 'advisor' ? `${hero.name} Street Brawl` : 'Street Brawl Tier List'}</h1>
          <div className="sub">
            {tab === 'advisor' ? 'Deadlock Street Brawl Helper' : 'Heroes and items graded by win rate and usage'}, data
            from the 30 days to {fetchedDate}
            {ageDays !== null && (
              <span className={stale ? 'stale' : ''}>
                {' '}
                ({ageDays} day{ageDays === 1 ? '' : 's'} old)
              </span>
            )}
          </div>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="View">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'advisor' ? (
        <>
          <input
            type="text"
            className="hero-search"
            placeholder="Find a hero…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Find a hero"
          />
          <div className="hero-strip" role="tablist" aria-label="Hero">
            {heroes.map((h) => {
              const match = search.trim() !== '' && h.name.toLowerCase().includes(search.trim().toLowerCase());
              return (
                <button
                  key={h.id}
                  ref={match ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'center' }) : undefined}
                  className={`hero-chip ${h.id === heroId ? 'active' : ''} ${match ? 'match' : ''}`}
                  onClick={() => setHeroId(h.id)}
                  role="tab"
                  aria-selected={h.id === heroId}
                >
                  <img src={img(h.images.small)} alt="" loading="lazy" />
                  <span>{h.name}</span>
                </button>
              );
            })}
          </div>
          <select
            className="hero-select"
            value={heroId}
            onChange={(e) => setHeroId(Number(e.target.value))}
            aria-label="Select hero"
          >
            {heroes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={setHeroId} />
        </>
      ) : (
        <TierList heroes={heroes} items={items} />
      )}
      <footer>
        Data: deadlock-api.com (aggregate analytics, assets). See the{' '}
        <a href="https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Street-Brawl-Advisor">
          Street Brawl Advisor
        </a>{' '}
        wiki page for the scoring function.
      </footer>
    </>
  );
}
