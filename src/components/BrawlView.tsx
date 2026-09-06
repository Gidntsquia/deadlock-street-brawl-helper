import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createPortal } from 'react-dom';
import type { Ability, Hero, Item } from '../types';
import { j, img } from '../data/load';
import { adviseDraft, enemiesFrom, roundTiers, type BrawlAnalytics, type BrawlConfig, type BrawlInput, type CardRead, type IconIndex, type Offer, type RankedOffer } from '../brawl';
import type { WorkerIn, WorkerOut } from '../brawl/worker';
import { ItemTile } from './ItemTile';

const PHONE_KEY = 'brawl-phone'; // localStorage: pairing code while the phone display is on
const NTFY_KEY = 'brawl-ntfy'; // localStorage: alternative ntfy server (tests, self-hosting)
const NTFY = 'https://ntfy.sh';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const CAPTURE_MS = 250; // pause between frames; the worker paces the loop (see worker.ts) so it keeps running while the tab is hidden
const NTFY_DAILY_LIMIT = 250; // ntfy.sh free tier: messages per IP per day
const ENEMY_SLOTS = 4;

interface Props { hero: Hero; heroes: Hero[]; items: Item[]; abilities: Ability[] }

/** Street Brawl draft advisor: the three cards on screen (read from a screen capture or typed in), ranked for this hero. */
export function BrawlView({ hero, heroes, items, abilities }: Props) {
  const [analytics, setAnalytics] = useState<BrawlAnalytics | null>(null);
  const [config, setConfig] = useState<BrawlConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(1);
  const [choice, setChoice] = useState(1);
  const [rerolls, setRerolls] = useState(1);
  const [enemies, setEnemies] = useState<number[]>(Array(ENEMY_SLOTS).fill(0));
  const [owned, setOwned] = useState<number[]>([]);
  const [cards, setCards] = useState<Offer[]>([]);
  const [capture, setCapture] = useState<'off' | 'starting' | 'on'>('off');
  const [status, setStatus] = useState('');
  const [pip, setPip] = useState<Window | null>(null);
  const [took_, setTook] = useState<string>('');
  const [phone, setPhone] = useState<string>(() => { try { return localStorage.getItem(PHONE_KEY) ?? ''; } catch { return ''; } });
  const [phoneQr, setPhoneQr] = useState('');
  const [phoneErr, setPhoneErr] = useState('');
  const [ntfy, setNtfyState] = useState<string>(() => { try { return (localStorage.getItem(NTFY_KEY) ?? NTFY).replace(/\/$/, ''); } catch { return NTFY; } });
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const offeredRef = useRef<Set<number>>(new Set()); // every card offered this game: settles inventory reads
  const ownedRef = useRef<number[]>([]);
  const cardsRef = useRef<Offer[]>([]);
  const prevCardsRef = useRef<Offer[]>([]); // the set on screen before the current one: the pick shows up in the grid after the screen has moved on
  useEffect(() => { ownedRef.current = owned; }, [owned]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  useEffect(() => { j<BrawlConfig>('brawl-config.json').then(setConfig).catch((e) => setError(String(e))); }, []);
  useEffect(() => { setAnalytics(null); j<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`).then(setAnalytics).catch((e) => setError(String(e))); }, [hero.id]);
  useEffect(() => { if (config) setRerolls(config.item_draft_rerolls_per_round[round - 1] ?? 1); }, [round, config]);

  const input: BrawlInput | null = useMemo(() => (analytics && config ? { hero, abilities, items, analytics, config } : null), [hero, abilities, items, analytics, config]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const catalog = useMemo(() => items.filter((i) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name)).sort((a, b) => a.item_tier - b.item_tier || a.name.localeCompare(b.name)), [items]);
  const enemyIds = enemies.filter(Boolean);
  const heroId = hero.id;
  const advice = useMemo(() => {
    if (!input || !cards.length) return null;
    const sets: Offer[][] = [[], [], []]; sets[choice - 1] = cards;
    return adviseDraft(input, { round, owned, enemies: enemyIds, sets });
  }, [input, cards, round, owned, choice, enemies]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked: RankedOffer[] = useMemo(() => advice?.sets[choice - 1] ?? [], [advice, choice]);
  const reroll = advice?.reroll && rerolls > 0 ? advice.reroll : null;
  const tiers = input ? roundTiers(input, round) : [];

  // phone display: publish the advice to a random ntfy.sh topic; the phone page (phone.html) subscribes to it, so no PC network setup is needed
  const setNtfy = (s: string) => { const v = s.trim().replace(/\/$/, '') || NTFY; setNtfyState(v); try { if (v === NTFY) localStorage.removeItem(NTFY_KEY); else localStorage.setItem(NTFY_KEY, v); } catch { /* private mode */ } };
  const phoneUrl = phone ? `${new URL('phone.html', location.href).href}#t=${phone}${ntfy !== NTFY ? `&s=${ntfy}` : ''}` : '';
  useEffect(() => { try { if (phone) localStorage.setItem(PHONE_KEY, phone); else localStorage.removeItem(PHONE_KEY); } catch { /* private mode */ } }, [phone]);
  useEffect(() => { if (phoneUrl) QRCode.toDataURL(phoneUrl, { margin: 1, width: 160, color: { dark: '#14181f', light: '#e8e2d0' } }).then(setPhoneQr); }, [phoneUrl]);
  const phoneState = useMemo(() => JSON.stringify({
    hero: hero.name, round, choice, took: took_, ownedCount: owned.length, status: capture === 'on' ? 'Waiting for the draft screen…' : 'Start the capture on the PC.',
    cards: ranked.map((r) => ({ name: r.item.name, enhanced: r.enhanced, score: r.score, usage: r.usage, winRate: r.winRate, why: r.why, icon: img(r.item.shop_image_webp ?? r.item.image_webp) })),
    reroll: reroll ? { currentBest: reroll.currentBest, expectedBest: reroll.expectedBest, tier: reroll.pool.tier } : null,
  }), [hero.name, round, choice, took_, owned.length, capture, ranked, reroll]);
  const phoneSent = useRef(0);
  useEffect(() => {
    if (!phone) return;
    // ntfy.sh allows NTFY_DAILY_LIMIT messages per IP per day, so only states worth showing are sent: the empty
    // moment between a pick and the next set (while capturing) is skipped; the next set carries the "took" line
    if (capture === 'on' && !ranked.length && phoneSent.current > 0) return;
    const id = setTimeout(() => fetch(`${ntfy}/brawl-${phone}`, { method: 'POST', body: phoneState }).then((r) => {
      phoneSent.current++;
      setPhoneErr(r.ok ? '' : r.status === 429 ? `${ntfy} refused the message: the free limit (${NTFY_DAILY_LIMIT} messages per day per IP) is used up; it refills over the day, or point the app at another ntfy server below` : `${ntfy} answered ${r.status}`);
    }).catch(() => setPhoneErr(`cannot reach ${ntfy}`)), 300);
    return () => clearTimeout(id);
  }, [phone, ntfy, phoneState]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null;
    workerRef.current?.terminate(); workerRef.current = null;
    setCapture('off'); setStatus('');
  }, []);
  const hasDpip = () => 'documentPictureInPicture' in window;
  /** Always-on-top overlay in Chrome/Edge (Document Picture-in-Picture); a plain popup window elsewhere (Firefox has no
   *  always-on-top web window, so put the popup on a second monitor or use the phone display). Must run inside a click. */
  const openPip = useCallback(async () => {
    const dpip = (window as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
    let w: Window;
    if (dpip) w = await dpip.requestWindow({ width: 460, height: 320 });
    else {
      const popup = window.open('', 'brawl-overlay', 'popup,width=460,height=320');
      if (!popup) { setStatus('the browser blocked the overlay window; allow pop-ups for this site, or use the phone display'); return; }
      w = popup; w.document.title = 'Brawl advice';
      setStatus('overlay opened as a window (this browser has no always-on-top web window: put it on a second monitor, or use the phone display)');
    }
    for (const s of Array.from(document.styleSheets)) { try { const el = document.createElement('style'); el.textContent = Array.from(s.cssRules).map((r) => r.cssText).join('\n'); w.document.head.appendChild(el); } catch { /* cross-origin sheet */ } }
    w.document.body.className = 'pip-body';
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
    return w;
  }, []);
  /** One click: open the always-on-top overlay (needs the click's user activation) and then start the screen capture. */
  const startCapture = async () => {
    try {
      setCapture('starting'); setStatus('loading icon index…');
      if (!pip && hasDpip()) { try { await openPip(); } catch { /* overlay is optional */ } } // without Document PiP the window is not on top, so it is opened only on request
      const index = await j<IconIndex>('brawl-icons.json');
      const w = new Worker(new URL('../brawl/worker.ts', import.meta.url), { type: 'module' });
      const tiers: Record<number, number> = {}; for (const i of items) tiers[i.id] = i.item_tier;
      w.postMessage({ type: 'init', index, tiers, intervalMs: CAPTURE_MS } satisfies WorkerIn);
      workerRef.current = w;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      streamRef.current = stream;
      stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
      const v = videoRef.current!; v.srcObject = stream; await v.play();
      setCapture('on'); setStatus('watching for the draft screen');
    } catch (e) { stopCapture(); setStatus(`capture failed: ${(e as Error).message}`); }
  };
  useEffect(() => () => stopCapture(), [stopCapture]);

  // frame loop: the worker asks for a frame ('tick'), the page draws the video to a canvas and sends the pixels,
  // the worker answers with what it read and asks again after CAPTURE_MS. Nothing here depends on page timers.
  useEffect(() => {
    if (capture !== 'on') return;
    const w = workerRef.current; if (!w) return;
    const canvas = document.createElement('canvas');
    const sendFrame = () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth) { w.postMessage({ type: 'idle' } satisfies WorkerIn); return; }
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const prefer = [...offeredRef.current, ...ownedRef.current];
      w.postMessage({ type: 'frame', width: data.width, height: data.height, buffer: data.data.buffer, prefer } satisfies WorkerIn, [data.data.buffer]);
    };
    const onMessage = (ev: MessageEvent<WorkerOut>) => {
      if (ev.data.type === 'tick') { sendFrame(); return; }
      const r = ev.data;
      const seen = r.reads.filter((x) => x.present).length;
      if (r.accepted) {
        const offers = r.reads.map(toOffer);
        for (const o of offers) offeredRef.current.add(o.itemId);
        prevCardsRef.current = cardsRef.current; cardsRef.current = offers; setCards(offers);
        const meta = r.meta!;
        if (meta.round) setRound(meta.round);
        if (meta.choice) setChoice(meta.choice);
        const foes = enemiesFrom(meta.bar, heroId);
        if (foes.length) setEnemies((prev) => { const n = [...prev]; for (const f of foes) if (!n.includes(f)) { const k = n.indexOf(0); if (k < 0) break; n[k] = f; } return n.every((x, i) => x === prev[i]) ? prev : n; });
      }
      if (r.inventory) {
        // the grid is the truth for what is owned; a new entry that was on offer is the card just taken
        const before = ownedRef.current, after = r.inventory;
        const gained = after.filter((id) => !before.includes(id));
        const pick = gained.find((id) => [...prevCardsRef.current, ...cardsRef.current].some((c) => c.itemId === id));
        if (pick) setTook(byId.get(pick)?.name ?? '');
        if (after.length !== before.length || gained.length) setOwned(after);
      }
      const names = seen === 3 ? r.reads.map((x) => byId.get(x.itemId)?.name ?? '?').join(' / ') : `${seen}/3 cards found`;
      setStatus(`${names} · ${r.ms.toFixed(0)} ms`);
    };
    w.addEventListener('message', onMessage);
    sendFrame(); // the worker's first tick may have arrived before this listener existed
    return () => w.removeEventListener('message', onMessage);
  }, [capture, byId, heroId]);

  const took = (r: RankedOffer) => {
    setOwned((o) => [...o, r.item.id]); setCards([]);
    if (choice < 3) setChoice(choice + 1); else if (round < 5) { setRound(round + 1); setChoice(1); }
  };
  const rerolled = () => { setRerolls((n) => Math.max(0, n - 1)); setCards([]); };
  const setCard = (k: number, id: number, enhanced: boolean) => setCards((c) => { const n = [...c]; while (n.length < 3) n.push({ itemId: 0 }); n[k] = { itemId: id, enhanced }; return n.filter((o) => o.itemId).slice(0, 3); });

  if (error) return <div className="error">{error}</div>;
  if (!input) return <div className="loading">Loading Street Brawl data…</div>;

  const advicePanel = (
    <div className="brawl-advice">
      {!cards.length && <div className="muted">{capture === 'on' ? status : 'Waiting for cards: start the screen capture or type the three items below.'}</div>}
      {took_ && <div className="muted">Took {took_} · {owned.length} owned</div>}
      {ranked.map((r, k) => (
        <button key={r.item.id} className={`brawl-card ${k === 0 ? 'best' : ''}`} onClick={() => took(r)} title={capture === 'on' ? "Picks are read from the inventory grid; click only if it missed" : "I took this one"}>
          <ItemTile item={r.item} />
          <span className="brawl-card-body">
            <b>{k === 0 ? 'TAKE' : `#${k + 1}`} {r.item.name}{r.enhanced ? ' (enhanced)' : ''}</b>
            <small>score {r.score.toFixed(2)} · used by {(r.usage * 100).toFixed(0)}% of {hero.name}s{r.winRate !== null ? `, wins ${(r.winRate * 100).toFixed(0)}%` : ''}{r.known ? '' : ' · no brawl data'}</small>
            {r.why.length > 0 && <small>{r.why.join('; ')}</small>}
          </span>
        </button>
      ))}
      {reroll && <div className="brawl-reroll">Re-roll this set: best card {reroll.currentBest.toFixed(2)}, a fresh tier-{reroll.pool.tier} set should offer {reroll.expectedBest.toFixed(2)} <button className="btn" onClick={rerolled}>I re-rolled</button></div>}
      {cards.length > 0 && !reroll && <div className="muted">Keep this set{rerolls ? '' : ' (no re-rolls left)'}.</div>}
    </div>
  );

  return (
    <div className="brawl">
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      <div className="panel brawl-controls">
        <div className="row">
          <label>Round <select value={round} onChange={(e) => { setRound(Number(e.target.value)); setChoice(1); setCards([]); }}>{[1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{r} ({input.config.gold_per_round[r - 1]} souls)</option>)}</select></label>
          <label>Choice <select value={choice} onChange={(e) => { setChoice(Number(e.target.value)); setCards([]); }}>{[1, 2, 3].map((c) => <option key={c} value={c}>{c} of 3{tiers[c - 1] ? ` · tier ${tiers[c - 1].normal} (rare ${tiers[c - 1].rare})` : ''}</option>)}</select></label>
          <label>Re-rolls left <input type="number" min={0} max={3} value={rerolls} onChange={(e) => setRerolls(Number(e.target.value))} /></label>
        </div>
        <div className="row">
          {enemies.map((id, k) => (
            <select key={k} value={id} aria-label={`Enemy ${k + 1}`} onChange={(e) => setEnemies((es) => es.map((x, i) => (i === k ? Number(e.target.value) : x)))}>
              <option value={0}>enemy {k + 1}</option>{heroes.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          ))}
        </div>
        <div className="row">
          {capture === 'on' ? <button className="btn" onClick={stopCapture}>Stop capture</button> : <button className="btn primary" onClick={startCapture} disabled={capture === 'starting'}>Capture game screen + overlay</button>}
          <button className="btn" onClick={pip ? () => pip.close() : openPip}>{pip ? 'Close overlay' : hasDpip() ? 'Always-on-top overlay' : 'Advice window'}</button>
          <span className="muted">{status}</span>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setPhone(phone ? '' : newCode())}>{phone ? 'Phone display: on' : 'Phone display'}</button>
          {phone && <span className="brawl-phone">
            {phoneQr && phoneUrl && <img src={phoneQr} alt="QR code for the phone page" width={160} height={160} />}
            <span className="muted">Scan with the phone, or open <a className="btn" href={phoneUrl}>{new URL('phone.html', location.href).href}</a> on it and type the code <code>{phone}</code>. {phoneErr}
              <label className="brawl-ntfy">ntfy server <input type="url" defaultValue={ntfy} placeholder={NTFY} onBlur={(e) => setNtfy(e.target.value)} /></label>
            </span>
          </span>}
        </div>
      </div>

      {pip ? createPortal(<div className="pip"><h2>{hero.name} · round {round}, choice {choice}</h2>{advicePanel}</div>, pip.document.body) : advicePanel}

      <div className="panel">
        <h2>Cards on screen</h2>
        <div className="muted">Filled in by the capture, or pick them here. Tick "enh." for an ENHANCED card.</div>
        <div className="row">
          {[0, 1, 2].map((k) => (
            <span key={k} className="brawl-pick">
              <select value={cards[k]?.itemId ?? 0} onChange={(e) => setCard(k, Number(e.target.value), !!cards[k]?.enhanced)}>
                <option value={0}>card {k + 1}</option>{catalog.map((i) => <option key={i.id} value={i.id}>T{i.item_tier} {i.name}</option>)}
              </select>
              <label><input type="checkbox" checked={!!cards[k]?.enhanced} onChange={(e) => cards[k] && setCard(k, cards[k].itemId, e.target.checked)} /> enh.</label>
            </span>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Owned ({owned.length})</h2>
        <div className="muted">{capture === 'on' ? 'Read from the inventory grid on the draft screen; tap to remove a mistake.' : 'Tap a card above when you take it; tap here to remove a mistake.'}</div>
        <div className="chips">{owned.map((id, k) => <button key={k} className="chip" onClick={() => setOwned((o) => o.filter((_, i) => i !== k))}>{byId.get(id)?.name}</button>)}</div>
        <div className="row"><button className="btn" onClick={() => { setOwned([]); setCards([]); setTook(''); offeredRef.current = new Set(); setRound(1); setChoice(1); setEnemies(Array(ENEMY_SLOTS).fill(0)); }}>New game</button></div>
      </div>
      <div className="muted brawl-foot"><img src={img(hero.images.small)} alt="" /> Layout anchors are for 2560×1440; other 16:9 sizes scale. The capture only reads pixels. Run Deadlock in borderless windowed mode so the overlay stays on top of it (Chrome/Edge), or turn on the phone display for exclusive fullscreen or Firefox.</div>
    </div>
  );
}

const toOffer = (r: CardRead): Offer => ({ itemId: r.itemId, enhanced: r.enhanced });
