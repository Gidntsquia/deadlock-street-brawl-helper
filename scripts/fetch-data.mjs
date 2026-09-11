// Data pipeline: snapshots every remote input the app needs into public/data/.
// After one successful run the app and the generator work fully offline.
//
// Outputs
//   public/data/items.json                 item catalog (all upgrade items)
//   public/data/heroes.json                active heroes with base stats + growth
//   public/data/abilities.json             abilities of active heroes (names, upgrades)
//   public/data/analytics/<hero_id>.json   item-stats, ability-order-stats, item-permutation-stats, and (top population)
//                                          build styles: per-style item/ability stats (see scripts/styles.mjs)
//   public/data/validation/<account>-<hero>.json  a top player's ~20 most recent matchmaking matches on one hero
//                                          with per-match purchases; 5 players per hero, chosen automatically
//                                          from the Phantom+ scoreboard (see selectValidationPlayers)   (VALIDATION ONLY)
//   public/data/img/{items,heroes,abilities}/  webp images so the app needs no network at all
//   public/data/brawl-config.json          Street Brawl mode constants (round budgets, draft tiers/weights)
//   public/data/analytics/brawl/<hero_id>.json  Street Brawl item-stats, pair stats, and item-stats vs every enemy hero
//   public/data/manifest.json              timestamps + counts + validation_sets (who was selected and why)
//
// Flags
//   --analytics-only            refresh analytics/* only
//   --brawl                     refresh the Street Brawl snapshot only
//   --validation-only           re-select players and refetch validation/* for every hero
//   --heroes 1,31               (with --validation-only or --analytics-only) only these hero ids; with --validation-only their entries are merged into manifest.validation_sets
//   --select-only               (with --validation-only) run the selection, print the table per hero, write nothing
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.deadlock-api.com';
import { detectStyles, usageOf, STYLE } from './styles.mjs';
const ASSETS = 'https://assets.deadlock-api.com';
const OUT = path.resolve('public/data');
// Held-out validation sets: for every active hero, VALIDATION_PLAYERS_PER_HERO top players chosen
// automatically by selectValidationPlayers(). Never read by the generator.
const VALIDATION_PLAYERS_PER_HERO = 5;
// Matches (matchmaking only, most recent first) fetched per selected (player, hero).
const VALIDATION_MATCH_TARGET = 20;
// Candidate pool per hero: the top N Phantom+ players by matches on the hero in the analytics window.
const VALIDATION_CANDIDATES = 25;
// Filters: a candidate needs at least this many recent games on the hero ...
const VALIDATION_MIN_RECENT = 5;
// ... and, once the sample is big enough (>= VALIDATION_WR_MIN_MATCHES), a recent win rate of at least this.
const VALIDATION_MIN_WINRATE = 0.40;
const VALIDATION_WR_MIN_MATCHES = 10;
// Score = recent_matches * (1 + EXPERIENCE_WEIGHT * ln(1 + total_hero_matches)) * recencyFactor,
// recencyFactor = exp(-daysSince(last_played) / RECENCY_HALFLIFE_DAYS) clamped to [RECENCY_FLOOR, 1].
const VALIDATION_EXPERIENCE_WEIGHT = 0.15;
const VALIDATION_RECENCY_DAYS = 14;
const VALIDATION_RECENCY_FLOOR = 0.25;
const VALIDATION_ONLY = process.argv.includes('--validation-only');
const SELECT_ONLY = process.argv.includes('--select-only');
// `--heroes 1,31` limits --validation-only to those hero ids (entries are merged into the existing manifest).
const HEROES_ARG = (() => {
  const i = process.argv.indexOf('--heroes');
  if (i < 0 || !process.argv[i + 1]) return null;
  return process.argv[i + 1].split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
})();
// Analytics window: last 30 days (live data; the window is recorded in manifest.json).
const WINDOW_DAYS = 30;
// High-rank population: average lobby badge >= 90 (Phantom and above). Chosen as the highest bracket
// where all three analytics endpoints are still well populated for every hero (Ascendant+ leaves
// ability-order sequences with <100 matches). Builds are generated from this population when it is
// large enough, so they follow what top-rank players actually buy rather than the all-rank average.
const TOP_BADGE = 90;
// `--analytics-only` refreshes only public/data/analytics/* from the existing heroes.json.
const ANALYTICS_ONLY = process.argv.includes('--analytics-only');
// `--brawl` refreshes only the Street Brawl snapshot (brawl-config.json, analytics/brawl/*).
const BRAWL_ONLY = process.argv.includes('--brawl');
// A 429 on match metadata can ask for an hour-long retry-after; wait at most this long, then throw so the
// caller skips that match and moves on to the next one (there are more candidates than the target).
const MAX_WAIT_MS = 45 * 1000;
// Street Brawl analytics: the API has no rank filter for this mode (400 "Cannot filter by average badge"),
// so there is one all-rank population. Enemy-filtered item-stats are fetched for every hero as the counter term.
const BRAWL_GAME_MODE = 'street_brawl';
let MIN_TS = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
// Rate limit is 200 req / 60 s -> ~350 ms between requests keeps us well under.
const SLEEP_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 429 || res.status >= 500) {
        // retry-after can be an hour on the match-metadata endpoint; cap it and let the caller skip the row
        // match metadata is limited to a few calls per hour per IP: honour its retry-after up to MAX_WAIT_MS there
        const maxWait = url.includes('/metadata') ? MAX_WAIT_MS : 60000;
        const asked = Number(res.headers.get('retry-after') || 0) * 1000 || 2000 * (i + 1);
        if (res.status === 429 && asked > maxWait) throw new Error(`429 retry-after ${Math.round(asked / 1000)}s for ${url}`);
        const wait = Math.min(maxWait, asked);
        console.warn(`  ${res.status} on ${url} – waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const j = await res.json();
      await sleep(SLEEP_MS);
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// Downloads an image once into public/data/img/<dir>/<id>.webp and returns the app-relative path.
async function saveImage(url, dir, id, suffix = '') {
  if (!url) return undefined;
  const rel = `img/${dir}/${id}${suffix}.webp`;
  const f = path.join(OUT, rel);
  await mkdir(path.dirname(f), { recursive: true });
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status}`);
    await writeFile(f, Buffer.from(await res.arrayBuffer()));
    await sleep(40);
    return rel;
  } catch (e) {
    console.warn(`  image failed ${url}: ${e.message}`);
    return undefined;
  }
}

const save = async (rel, data) => {
  const f = path.join(OUT, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(data));
  console.log(`wrote ${rel}`);
};

// Keep only fields the app needs; the SVG-heavy description blobs are kept
// because the item card renders their text.
function slimItem(it) {
  const props = {};
  for (const [k, v] of Object.entries(it.properties || {})) {
    props[k] = { value: v.value, label: v.label, postfix: v.postfix, prefix: v.prefix, css_class: v.css_class };
  }
  return {
    id: it.id, class_name: it.class_name, name: it.name, cost: it.cost ?? 0,
    item_tier: it.item_tier, item_slot_type: it.item_slot_type,
    shopable: !!it.shopable, disabled: !!it.disabled, is_active_item: !!it.is_active_item,
    activation: it.activation, component_items: it.component_items || [],
    shop_image_webp: it.shop_image_webp || it.image_webp, image_webp: it.image_webp,
    description: it.description || {}, tooltip_sections: it.tooltip_sections || [],
    properties: props,
  };
}

function slimHero(h) {
  return {
    id: h.id, name: h.name, class_name: h.class_name,
    description: h.description, images: { small: h.images?.icon_image_small_webp, card: h.images?.icon_hero_card_webp },
    starting_stats: Object.fromEntries(Object.entries(h.starting_stats || {}).map(([k, v]) => [k, v.value])),
    standard_level_up_upgrades: h.standard_level_up_upgrades || {},
    level_info: h.level_info || {},
    abilities: [h.items?.signature1, h.items?.signature2, h.items?.signature3, h.items?.signature4].filter(Boolean),
    gun_tag: h.gun_tag, tags: h.tags,
  };
}

function slimAbility(a) {
  return {
    id: a.id, class_name: a.class_name, name: a.name, hero: a.hero, image_webp: a.image_webp,
    ability_type: a.ability_type, description: a.description?.desc || '',
    upgrades: (a.upgrades || []).map((u) => (u.property_upgrades || []).map((p) => ({ name: p.name, bonus: String(p.bonus) }))),
    properties: Object.fromEntries(
      Object.entries(a.properties || {})
        .filter(([, v]) => v && v.value !== undefined)
        .map(([k, v]) => [k, { value: v.value, scale: v.scale_function?.specific_stat_scale_type || v.scale_function?.scaling_stats || null }]),
    ),
  };
}

async function fetchPopulation(heroId, extra = '') {
  const q = `hero_id=${heroId}&min_unix_timestamp=${MIN_TS}${extra}`;
  const [item_stats, ability_order_stats, permutation_stats] = await Promise.all([
    getJson(`${API}/v1/analytics/item-stats?${q}`),
    getJson(`${API}/v1/analytics/ability-order-stats?${q}&min_matches=5`),
    getJson(`${API}/v1/analytics/item-permutation-stats?${q}&comb_size=2`),
  ]);
  // Ability sequences and pair stats are very large (10k+ rows); keep the most-played rows.
  const abilitySeqs = [...ability_order_stats].sort((a, b) => b.matches - a.matches).slice(0, 400);
  const pairs = [...permutation_stats].sort((a, b) => b.matches - a.matches).slice(0, 600);
  return { item_stats, ability_order_stats: abilitySeqs, permutation_stats: pairs };
}

// Build styles. For every candidate anchor item we fetch the hero's item stats CONDITIONAL on that
// item having been bought (include_item_ids). detectStyles() picks the anchors whose games look
// materially different from the population (see scripts/styles.mjs). Each detected style then gets its
// own item + ability-order population (include the style's seed item); the main style is the population
// with every alternative anchor excluded, so each build is generated from games played its way.
async function fetchStyles(hero, topQ, top, shopIds) {
  const { n: N, u } = usageOf(top.item_stats.filter((s) => shopIds.has(s.item_id)));
  const cands = [...u].filter(([, x]) => x >= STYLE.candidateShare[0] && x <= STYLE.candidateShare[1]).map(([id]) => id);
  const conditional = {};
  for (const id of cands) conditional[id] = (await getJson(`${API}/v1/analytics/item-stats?${topQ}&include_item_ids=${id}`)).filter((s) => shopIds.has(s.item_id));
  const found = detectStyles(top.item_stats.filter((s) => shopIds.has(s.item_id)), conditional);
  if (!found.length) return { styles: [], scanned: cands.length };
  const population = async (filter) => {
    const [item_stats, ability_order_stats] = await Promise.all([
      getJson(`${API}/v1/analytics/item-stats?${topQ}${filter}`),
      getJson(`${API}/v1/analytics/ability-order-stats?${topQ}${filter}&min_matches=5`),
    ]);
    return { item_stats, ability_order_stats: [...ability_order_stats].sort((a, b) => b.matches - a.matches).slice(0, 400) };
  };
  const excluded = found.flatMap((s) => s.anchors);
  const main = await population(`&exclude_item_ids=${excluded.join(',')}`);
  const styles = [{ key: 'main', seed: null, anchors: [], exclude: excluded, matches: Math.max(0, ...main.item_stats.map((s) => s.matches)), ...main }];
  for (const s of found) {
    const pop = await population(`&include_item_ids=${s.seed}`);
    styles.push({ key: `style-${s.seed}`, seed: s.seed, anchors: s.anchors, exclude: [], matches: Math.max(0, ...pop.item_stats.map((s) => s.matches)), ...pop });
  }
  for (const s of styles) s.share = s.matches / N;
  return { styles, scanned: cands.length };
}

async function fetchAnalytics(heroes, manifest) {
  const targets = HEROES_ARG ? heroes.filter((h) => HEROES_ARG.includes(h.id)) : heroes;
  console.log(`4/5 per-hero analytics (${targets.length} heroes, all ranks + badge>=${TOP_BADGE}, plus build styles)`);
  const shopIds = new Set(JSON.parse(await readFile(path.join(OUT, 'items.json'), 'utf8')).filter((i) => i.shopable && !i.disabled && i.cost > 0).map((i) => i.id));
  for (const h of targets) {
    const all = await fetchPopulation(h.id);
    const topQ = `hero_id=${h.id}&min_unix_timestamp=${MIN_TS}&min_average_badge=${TOP_BADGE}`;
    const top = await fetchPopulation(h.id, `&min_average_badge=${TOP_BADGE}`);
    const topMatches = Math.max(0, ...top.item_stats.map((s) => s.matches));
    const { styles, scanned } = await fetchStyles(h, topQ, top, shopIds);
    console.log(`   ${h.name}: top-rank max item matches ${topMatches}; ${scanned} anchors scanned, ${Math.max(0, styles.length - 1)} alternative style(s)${styles.length ? ': ' + styles.slice(1).map((s) => `${s.seed} ${(s.share * 100).toFixed(0)}%`).join(', ') : ''}`);
    await save(`analytics/${h.id}.json`, { hero_id: h.id, ...all, top: { min_average_badge: TOP_BADGE, ...top, styles } });
  }
  manifest.counts.analytics_heroes = heroes.length;
  manifest.top_min_average_badge = TOP_BADGE;
}

// Steps 1-4 of the selection for one hero: scoreboard candidates -> hero-stats -> score/filter -> names.
async function selectValidationPlayers(hero) {
  const base = `${API}/v1/analytics/scoreboards/players?hero_id=${hero.id}&min_average_badge=${TOP_BADGE}&min_unix_timestamp=${MIN_TS}&limit=${VALIDATION_CANDIDATES}`;
  const byMatches = await getJson(`${base}&sort_by=matches`);
  const byWins = await getJson(`${base}&sort_by=wins`);
  const wins = new Map(byWins.map((r) => [r.account_id, r.value]));
  const now = Date.now() / 1000;
  const cands = [];
  for (const r of byMatches) {
    const recent_matches = r.matches ?? r.value;
    const recent_wins = wins.get(r.account_id) ?? 0;
    let total_hero_matches = recent_matches, last_played = 0;
    try {
      const hs = await getJson(`${API}/v1/players/${r.account_id}/hero-stats`);
      const row = (hs || []).find((x) => x.hero_id === hero.id);
      if (row) { total_hero_matches = row.matches_played ?? recent_matches; last_played = row.last_played ?? 0; }
    } catch (e) { console.warn(`  hero-stats failed for ${r.account_id}: ${e.message}`); }
    const days = last_played ? Math.max(0, (now - last_played) / 86400) : VALIDATION_RECENCY_DAYS * 10;
    const recency = Math.min(1, Math.max(VALIDATION_RECENCY_FLOOR, Math.exp(-days / VALIDATION_RECENCY_DAYS)));
    const score = recent_matches * (1 + VALIDATION_EXPERIENCE_WEIGHT * Math.log(1 + total_hero_matches)) * recency;
    const wr = recent_matches ? recent_wins / recent_matches : 0;
    const passes = recent_matches >= VALIDATION_MIN_RECENT && !(recent_matches >= VALIDATION_WR_MIN_MATCHES && wr < VALIDATION_MIN_WINRATE);
    cands.push({ account_id: r.account_id, recent_matches, recent_wins, total_hero_matches, last_played, score, passes });
  }
  cands.sort((a, b) => b.score - a.score);
  let picked = cands.filter((c) => c.passes).slice(0, VALIDATION_PLAYERS_PER_HERO);
  if (picked.length < VALIDATION_PLAYERS_PER_HERO) {
    const need = VALIDATION_PLAYERS_PER_HERO - picked.length;
    const fill = cands.filter((c) => !c.passes).slice(0, need);
    console.warn(`  ${hero.name}: only ${picked.length} candidates pass the filters – filling ${fill.length} from the unfiltered top`);
    picked = [...picked, ...fill];
  }
  const names = new Map();
  if (picked.length) {
    try {
      const steam = await getJson(`${API}/v1/players/steam?account_ids=${picked.map((c) => c.account_id).join(',')}`);
      for (const p of steam || []) if (p.personaname) names.set(p.account_id, p.personaname);
    } catch (e) { console.warn(`  steam names failed: ${e.message}`); }
  }
  return picked.map((c, i) => ({
    account_id: c.account_id, player: names.get(c.account_id) || `#${c.account_id}`, hero_id: hero.id, hero: hero.name,
    selection: { rank: i + 1, recent_matches: c.recent_matches, recent_wins: c.recent_wins, total_hero_matches: c.total_hero_matches, last_played: c.last_played, score: Number(c.score.toFixed(2)) },
  }));
}

function printSelection(hero, sel) {
  console.log(`   ${hero.name} (${hero.id})`);
  console.table(sel.map((v) => ({
    rank: v.selection.rank, account_id: v.account_id, player: v.player, recent: v.selection.recent_matches,
    wins: v.selection.recent_wins, total: v.selection.total_hero_matches,
    last_played: new Date(v.selection.last_played * 1000).toISOString().slice(0, 10), score: v.selection.score,
  })));
}

// Step 5: the player's most recent matchmaking matches on the hero, with per-match purchases.
async function fetchPlayerMatches(v, histories) {
  if (!histories.has(v.account_id)) histories.set(v.account_id, await getJson(`${API}/v1/players/${v.account_id}/match-history`));
  const hist = histories.get(v.account_id);
  const onHero = hist.filter((m) => m.hero_id === v.hero_id);
  const real = onHero.filter((m) => (m.match_mode === 1 || m.match_mode === 2) && m.game_mode === 1).sort((a, b) => b.start_time - a.start_time);
  const purchases = [];
  for (const m of real) {
    if (purchases.length >= VALIDATION_MATCH_TARGET) break;
    try {
      const meta = await getJson(`${API}/v1/matches/${m.match_id}/metadata`);
      const mi = meta.match_info;
      const p = (mi.players || []).find((x) => x.account_id === v.account_id);
      if (!p || !(p.items || []).length) continue; // no purchase data (abandon etc.): does not count toward the target
      purchases.push({
        match_id: m.match_id, start_time: mi.start_time, duration_s: mi.duration_s,
        match_mode: mi.match_mode, game_mode: mi.game_mode,
        won: p.team === mi.winning_team, net_worth: p.net_worth,
        items: (p.items || []).map((it) => ({ item_id: it.item_id, game_time_s: it.game_time_s, sold_time_s: it.sold_time_s })),
      });
    } catch (e) { console.warn(`  skip match ${m.match_id}: ${e.message}`); }
  }
  return { total_hero_matches: onHero.length, matchmaking_hero_matches: real.length, matches: purchases };
}

async function fetchValidation(heroes, manifest) {
  const targets = HEROES_ARG ? heroes.filter((h) => HEROES_ARG.includes(h.id)) : heroes;
  console.log(`5/5 held-out top-player matches (validation only): ${targets.length} heroes x ${VALIDATION_PLAYERS_PER_HERO} players x ${VALIDATION_MATCH_TARGET} matches${SELECT_ONLY ? ' [select-only]' : ''}`);
  const selected = [];
  for (const h of targets) {
    const sel = await selectValidationPlayers(h);
    printSelection(h, sel);
    selected.push(...sel);
  }
  if (SELECT_ONLY) return;
  const histories = new Map();
  const entries = [];
  for (const v of selected) {
    const data = await fetchPlayerMatches(v, histories);
    const file = `validation/${v.account_id}-${v.hero_id}.json`;
    await save(file, { ...v, ...data });
    entries.push({ ...v, file, matches: data.matches.length });
  }
  const targetIds = new Set(targets.map((h) => h.id));
  const kept = HEROES_ARG ? (manifest.validation_sets || []).filter((v) => !targetIds.has(v.hero_id)) : [];
  manifest.validation_sets = [...kept, ...entries].sort((a, b) => a.hero_id - b.hero_id || a.selection?.rank - b.selection?.rank);
  manifest.counts.validation_sets = manifest.validation_sets.length;
  manifest.validation = { players_per_hero: VALIDATION_PLAYERS_PER_HERO, match_target: VALIDATION_MATCH_TARGET, selected_at: new Date().toISOString() };
  delete manifest.counts.zergggy_matches_with_purchases;
}

// One row per item, slimmed to what the counter term needs.
const slimStat = (s) => ({ item_id: s.item_id, wins: s.wins, matches: s.matches });

async function fetchBrawl(heroes, manifest) {
  console.log(`brawl 1/2 mode config`);
  const generic = await getJson(`${ASSETS}/v2/generic-data`);
  await save('brawl-config.json', { fetched_at: new Date().toISOString(), ...generic.street_brawl });
  console.log(`brawl 2/2 per-hero Street Brawl analytics (${heroes.length} heroes x ${heroes.length} enemies)`);
  for (const h of heroes) {
    const q = `hero_id=${h.id}&game_mode=${BRAWL_GAME_MODE}&min_unix_timestamp=${MIN_TS}`;
    const item_stats = await getJson(`${API}/v1/analytics/item-stats?${q}`);
    const perm = await getJson(`${API}/v1/analytics/item-permutation-stats?${q}&comb_size=2`);
    const permutation_stats = [...perm].sort((a, b) => b.matches - a.matches).slice(0, 600);
    const vs = {};
    for (const e of heroes) {
      if (e.id === h.id) continue;
      try { vs[e.id] = (await getJson(`${API}/v1/analytics/item-stats?${q}&enemy_hero_ids=${e.id}`)).map(slimStat); }
      catch (err) { console.warn(`  vs ${e.name} failed: ${err.message}`); }
    }
    const maxM = Math.max(0, ...item_stats.map((s) => s.matches));
    console.log(`   ${h.name}: max item matches ${maxM}, ${item_stats.length} items, ${Object.keys(vs).length} enemies`);
    await save(`analytics/brawl/${h.id}.json`, { hero_id: h.id, game_mode: BRAWL_GAME_MODE, item_stats, permutation_stats, vs });
  }
  manifest.brawl = { fetched_at: new Date().toISOString(), game_mode: BRAWL_GAME_MODE, heroes: heroes.length };
}

async function main() {
  if (BRAWL_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    MIN_TS = manifest.min_unix_timestamp;
    await fetchBrawl(heroes, manifest);
    await save('manifest.json', manifest);
    return;
  }
  await mkdir(OUT, { recursive: true });
  if (VALIDATION_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    MIN_TS = manifest.min_unix_timestamp;
    await fetchValidation(heroes, manifest);
    if (!SELECT_ONLY) await save('manifest.json', manifest);
    return;
  }
  if (ANALYTICS_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    MIN_TS = manifest.min_unix_timestamp; // keep the same window as the rest of the snapshot
    manifest.analytics_fetched_at = new Date().toISOString();
    await fetchAnalytics(heroes, manifest);
    await save('manifest.json', manifest);
    return;
  }
  const manifest = { fetched_at: new Date().toISOString(), min_unix_timestamp: MIN_TS, window_days: WINDOW_DAYS, counts: {} };

  console.log('1/5 item catalog');
  const items = (await getJson(`${ASSETS}/v2/items/by-type/upgrade`)).map(slimItem);
  console.log(`   downloading ${items.length} item images`);
  for (const it of items) {
    it.remote_shop_image = it.shop_image_webp;
    const local = await saveImage(it.shop_image_webp, 'items', it.id);
    if (local) { it.shop_image_webp = local; it.image_webp = local; }
  }
  await save('items.json', items);
  manifest.counts.items = items.length;
  manifest.counts.shopable_items = items.filter((i) => i.shopable && !i.disabled).length;

  console.log('2/5 heroes');
  const heroesRaw = await getJson(`${ASSETS}/v2/heroes`);
  const active = heroesRaw.filter((h) => h.player_selectable && !h.disabled && !h.in_development);
  const heroes = active.map(slimHero);
  for (const h of heroes) {
    const l = await saveImage(h.images.small, 'heroes', h.id); if (l) h.images.small = l;
    // card art is what the Street Brawl draft screen shows in the top bar; the recogniser matches portraits against it
    const c = await saveImage(h.images.card, 'heroes', h.id, '-card'); if (c) h.images.card = c;
  }
  await save('heroes.json', heroes);
  manifest.counts.heroes = heroes.length;

  console.log('3/5 abilities');
  const abilitiesRaw = await getJson(`${ASSETS}/v2/items/by-type/ability`);
  const activeIds = new Set(active.map((h) => h.id));
  const abilities = abilitiesRaw.filter((a) => activeIds.has(a.hero)).map(slimAbility);
  const sigNames = new Set(heroes.flatMap((h) => h.abilities));
  for (const a of abilities) if (sigNames.has(a.class_name)) { const l = await saveImage(a.image_webp, 'abilities', a.id); if (l) a.image_webp = l; }
  await save('abilities.json', abilities);
  manifest.counts.abilities = abilities.length;

  await fetchAnalytics(heroes, manifest);

  await fetchValidation(heroes, manifest);
  await fetchBrawl(heroes, manifest);

  await save('manifest.json', manifest);
  console.log('done', manifest.counts);
}

main().catch((e) => { console.error(e); process.exit(1); });
