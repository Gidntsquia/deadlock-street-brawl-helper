import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Ability, Hero, Item } from '../types';
import { j, img } from '../data/load';
import {
  adviseDraft,
  enemiesFrom,
  roundTiers,
  topItemsByTier,
  type BrawlAnalytics,
  type BrawlConfig,
  type BrawlInput,
  type CardRead,
  type IconIndex,
  type Offer,
  type RankedOffer,
  type RerollAdvice,
  brawlAbilityOrder,
} from '../brawl';
import type { WorkerIn, WorkerOut } from '../brawl/worker';
import { drawReads } from '../brawl/draw';
import { ItemTile } from './ItemTile';
import { log } from '../log';
import { usePersisted, isNumber, isNumberArray } from '../hooks/usePersisted';

const CAPTURE_MS = 250; // pause between frames; the worker paces the loop (see worker.ts) so it keeps running while the tab is hidden
const ENEMY_SLOTS = 4;
const isElectron = typeof window !== 'undefined' && !!window.brawlAPI;

interface Props {
  hero: Hero;
  heroes: Hero[];
  items: Item[];
  abilities: Ability[];
  onHero: (id: number) => void;
}

/** Street Brawl draft advisor: the three cards on screen (read from a screen capture or typed in), ranked for this hero. */
export function BrawlView({ hero, heroes, items, abilities, onHero }: Props) {
  const [loaded, setLoaded] = useState<{ heroId: number; analytics: BrawlAnalytics } | null>(null);
  const [config, setConfig] = useState<BrawlConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = usePersisted('round', isNumber, 1);
  const [choice, setChoice] = useState(1);
  const [rerollsLeft, setRerollsLeft] = useState<number | null>(null); // null: however many the round starts with
  const [rerollsRound, setRerollsRound] = useState(1);
  const isEnemies = (v: unknown): v is number[] => isNumberArray(v) && v.length === ENEMY_SLOTS;
  const [enemies, setEnemies] = usePersisted('enemies', isEnemies, Array(ENEMY_SLOTS).fill(0));
  const [owned, setOwned] = useState<number[]>([]);
  const [cards, setCards] = useState<Offer[]>([]);
  const [capture, setCapture] = useState<'off' | 'starting' | 'on'>('off');
  const [status, setStatus] = useState('');
  const [pip, setPip] = useState<Window | null>(null);
  const [took_, setTook] = useState<string>('');
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const offeredRef = useRef<Set<number>>(new Set()); // every card offered this game: settles inventory reads
  const ownedRef = useRef<number[]>([]);
  const cardsRef = useRef<Offer[]>([]);
  const prevCardsRef = useRef<Offer[]>([]); // the set on screen before the current one: the pick shows up in the grid after the screen has moved on
  const readsRef = useRef<CardRead[]>([]); // latest card positions on screen, for the preview highlight
  const rankedRef = useRef<RankedOffer[]>([]);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    ownedRef.current = owned;
  }, [owned]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    j<BrawlConfig>('brawl-config.json')
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    j<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`)
      .then((a) => setLoaded({ heroId: hero.id, analytics: a }))
      .catch((e) => setError(String(e)));
  }, [hero.id]);
  // tagged with the hero it was fetched for, so switching hero shows the loader again instead of the old hero's numbers
  const analytics = loaded?.heroId === hero.id ? loaded.analytics : null;
  // a new round refills the re-rolls; until then the count is whatever the player has spent it down to
  if (rerollsRound !== round) {
    setRerollsRound(round);
    setRerollsLeft(null);
  }
  const rerolls = rerollsLeft ?? config?.item_draft_rerolls_per_round[round - 1] ?? 1;

  const input: BrawlInput | null = useMemo(
    () => (analytics && config ? { hero, abilities, items, analytics, config } : null),
    [hero, abilities, items, analytics, config],
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const catalog = useMemo(
    () =>
      items
        .filter((i) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name))
        .sort((a, b) => a.item_tier - b.item_tier || a.name.localeCompare(b.name)),
    [items],
  );
  const enemyIds = enemies.filter(Boolean);
  const heroId = hero.id;
  const advice = useMemo(() => {
    if (!input || !cards.length) return null;
    const sets: Offer[][] = [[], [], []];
    sets[choice - 1] = cards;
    return adviseDraft(input, { round, owned, enemies: enemyIds, sets });
  }, [input, cards, round, owned, choice, enemies]);
  const ranked: RankedOffer[] = useMemo(() => advice?.sets[choice - 1] ?? [], [advice, choice]);
  useEffect(() => {
    rankedRef.current = ranked;
  }, [ranked]);
  const reroll = advice?.reroll && rerolls > 0 ? advice.reroll : null;
  const tiers = input ? roundTiers(input, round) : [];
  const topItems = useMemo(() => (input ? topItemsByTier(input) : []), [input]);
  const abilityOrder = useMemo(() => (input ? brawlAbilityOrder(input) : null), [input]);
  // Street Brawl gives roughly one ability point per draft choice: round 1 choice 1 is step 1, etc.
  const abilityStepNow = (round - 1) * 3 + choice - 1;

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setCapture('off');
    setStatus('');
    log('brawl-view', 'info', 'capture.stop');
  }, []);
  const hasDpip = () => 'documentPictureInPicture' in window;
  /** Always-on-top overlay in Chrome/Edge (Document Picture-in-Picture); a plain popup window elsewhere (Firefox has no
   *  always-on-top web window, so put the popup on a second monitor or use the phone display). Must run inside a click. */
  const openPip = useCallback(async () => {
    const dpip = (
      window as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }
    ).documentPictureInPicture;
    let w: Window;
    if (dpip) w = await dpip.requestWindow({ width: 460, height: 320 });
    else {
      const popup = window.open('', 'brawl-overlay', 'popup,width=460,height=320');
      if (!popup) {
        setStatus('the browser blocked the overlay window; allow pop-ups for this site');
        return;
      }
      w = popup;
      w.document.title = 'Brawl advice';
      setStatus(
        'overlay opened as a window (this browser has no always-on-top web window: put it on a second monitor)',
      );
    }
    for (const s of Array.from(document.styleSheets)) {
      try {
        const el = document.createElement('style');
        el.textContent = Array.from(s.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        w.document.head.appendChild(el);
      } catch {
        /* cross-origin sheet */
      }
    }
    w.document.body.className = 'pip-body';
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
    return w;
  }, []);
  /** One click: start the screen capture (needs the click's user activation) and then open the always-on-top overlay. */
  const startCapture = async () => {
    try {
      setCapture('starting');
      setStatus('loading icon index…');
      const index = await j<IconIndex>('brawl-icons.json');
      const w = new Worker(new URL('../brawl/worker.ts', import.meta.url), { type: 'module' });
      const tiers: Record<number, number> = {};
      for (const i of items) tiers[i.id] = i.item_tier;
      w.postMessage({ type: 'init', index, tiers, intervalMs: CAPTURE_MS } satisfies WorkerIn);
      workerRef.current = w;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      streamRef.current = stream;
      stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      setCapture('on');
      setStatus('watching for the draft screen');
      log('brawl-view', 'info', 'capture.start');
      // Electron already draws its own always-on-top overlay window (electron/main.ts); the in-page
      // Document-PiP overlay is only for the browser path.
      if (!isElectron && !pip && hasDpip()) {
        try {
          await openPip();
        } catch {
          /* overlay is optional */
        }
      } // getDisplayMedia already consumed this click's activation, so requestWindow may need a second click here; that's fine since capture already started
    } catch (e) {
      stopCapture();
      setStatus(`capture failed: ${(e as Error).message}`);
      log('brawl-view', 'error', 'capture.fail', { message: (e as Error).message });
    }
  };
  useEffect(() => () => stopCapture(), [stopCapture]);

  // Belt-and-braces: if the <video> element instance ever changes (React remounting it for any reason)
  // while a capture stream is live, re-attach it instead of leaving the new element with no srcObject.
  useEffect(() => {
    const v = videoRef.current;
    const stream = streamRef.current;
    if (!v || !stream) return;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play();
      log('brawl-view', 'info', 'capture.rebind');
    }
  });

  // Electron: no picker to click through (main.ts serves the Deadlock window via setDisplayMediaRequestHandler),
  // so start capture as soon as the game window is found instead of waiting for a click.
  useEffect(() => {
    if (!isElectron) return;
    return window.brawlAPI!.onGameRect((rect) => {
      if (rect && capture === 'off') void startCapture();
      else if (!rect && capture !== 'off') stopCapture();
    });
  }, [capture]);

  // Electron: main.ts denies getDisplayMedia (callback(null)) instead of falling back to some other window
  // when Deadlock isn't found, so tell the user why capture never starts instead of leaving them guessing.
  useEffect(() => {
    if (!isElectron) return;
    return window.brawlAPI!.onCaptureDenied(() => setStatus('Deadlock window not found'));
  }, []);

  // frame loop: the worker asks for a frame ('tick'), the page draws the video to a canvas and sends the pixels,
  // the worker answers with what it read and asks again after CAPTURE_MS. Nothing here depends on page timers.
  useEffect(() => {
    if (capture !== 'on') return;
    const w = workerRef.current;
    if (!w) return;
    const canvas = document.createElement('canvas');
    const sendFrame = () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth) {
        w.postMessage({ type: 'idle' } satisfies WorkerIn);
        return;
      }
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const prefer = [...offeredRef.current, ...ownedRef.current];
      w.postMessage(
        { type: 'frame', width: data.width, height: data.height, buffer: data.data.buffer, prefer } satisfies WorkerIn,
        [data.data.buffer],
      );
      const bestId = rankedRef.current[0]?.item.id ?? null;
      const pv = previewRef.current;
      if (pv) {
        const pctx = pv.getContext('2d');
        if (pctx) {
          const scale = pv.width / v.videoWidth;
          pctx.drawImage(v, 0, 0, pv.width, pv.height);
          drawReads(pctx, readsRef.current, bestId, scale, scale);
        }
      }
      window.brawlAPI?.sendOverlayState({
        reads: readsRef.current,
        bestId,
        frameW: v.videoWidth,
        frameH: v.videoHeight,
      });
    };
    const onMessage = (ev: MessageEvent<WorkerOut>) => {
      if (ev.data.type === 'tick') {
        sendFrame();
        return;
      }
      const r = ev.data;
      readsRef.current = r.reads;
      const seen = r.reads.filter((x) => x.present).length;
      if (r.accepted) {
        const offers = r.reads.map(toOffer);
        for (const o of offers) offeredRef.current.add(o.itemId);
        prevCardsRef.current = cardsRef.current;
        cardsRef.current = offers;
        setCards(offers);
        const meta = r.meta!;
        log('brawl-view', 'info', 'worker.accept', {
          round: meta.round,
          choice: meta.choice,
          items: offers.map((o) => o.itemId),
        });
        if (meta.round) setRound(meta.round);
        if (meta.choice) setChoice(meta.choice);
        // the square-topped portrait is the player's: switch the app's hero to it (the enemies are then the other side)
        const me = meta.self && heroes.some((h) => h.id === meta.self) ? meta.self : heroId;
        if (me !== heroId) {
          log('brawl-view', 'info', 'hero.switch', { from: heroId, to: me });
          onHero(me);
          setOwned([]);
          offeredRef.current.clear();
        }
        const foes = enemiesFrom(meta.bar, me);
        if (foes.length)
          setEnemies((prev) => {
            const n = [...prev];
            for (const f of foes)
              if (!n.includes(f)) {
                const k = n.indexOf(0);
                if (k < 0) break;
                n[k] = f;
              }
            return n.every((x, i) => x === prev[i]) ? prev : n;
          });
      }
      if (r.inventory) {
        // the grid is the truth for what is owned; a new entry that was on offer is the card just taken
        const before = ownedRef.current,
          after = r.inventory;
        const gained = after.filter((id) => !before.includes(id));
        const pick = gained.find((id) => [...prevCardsRef.current, ...cardsRef.current].some((c) => c.itemId === id));
        if (pick) setTook(byId.get(pick)?.name ?? '');
        if (after.length !== before.length || gained.length) setOwned(after);
      }
      const names =
        seen === 3 ? r.reads.map((x) => byId.get(x.itemId)?.name ?? '?').join(' / ') : `${seen}/3 cards found`;
      setStatus(`${names} · ${r.ms.toFixed(0)} ms`);
    };
    w.addEventListener('message', onMessage);
    sendFrame(); // the worker's first tick may have arrived before this listener existed
    return () => w.removeEventListener('message', onMessage);
  }, [capture, byId, heroId, heroes, onHero]);

  const took = (r: RankedOffer) => {
    setOwned((o) => [...o, r.item.id]);
    setCards([]);
    if (choice < 3) setChoice(choice + 1);
    else if (round < 5) {
      setRound(round + 1);
      setChoice(1);
    }
  };
  const rerolled = () => {
    setRerollsLeft(Math.max(0, rerolls - 1));
    setCards([]);
  };
  const setCard = (k: number, id: number, enhanced: boolean) =>
    setCards((c) => {
      const n = [...c];
      while (n.length < 3) n.push({ itemId: 0 });
      n[k] = { itemId: id, enhanced };
      return n.filter((o) => o.itemId).slice(0, 3);
    });

  // Never early-return before the <video>: doing so unmounts the hidden element holding the capture
  // stream, so the worker loop stops getting frames on any hero change (loaded.heroId !== hero.id
  // reopens this loading gap until the new hero's analytics resolve). Show the loading/error state
  // inside the advice area instead.
  const advicePanel = (
    <AdvicePanel
      input={input}
      error={error}
      cards={cards}
      capture={capture}
      status={status}
      took_={took_}
      owned={owned}
      ranked={ranked}
      reroll={reroll}
      rerolls={rerolls}
      hero={hero}
      took={took}
      rerolled={rerolled}
    />
  );

  return (
    <div className="brawl">
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      <div className="panel brawl-controls">
        {capture === 'off' && (
          <div className="muted brawl-howto">
            {isElectron ? (
              'Start Deadlock in borderless windowed mode; the overlay starts on its own.'
            ) : (
              <>
                1. Set Deadlock to <b>borderless windowed</b> mode. 2. Click <b>Capture game screen + overlay</b> below.
                3. Pick the Deadlock window when asked. Then just play — advice appears on top of the game.
              </>
            )}
          </div>
        )}
        <div className="row">
          <label>
            Round{' '}
            <select
              value={round}
              onChange={(e) => {
                setRound(Number(e.target.value));
                setChoice(1);
                setCards([]);
              }}
            >
              {[1, 2, 3, 4, 5].map((r) => (
                <option key={r} value={r}>
                  {r} ({config?.gold_per_round[r - 1] ?? '…'} souls)
                </option>
              ))}
            </select>
          </label>
          <label>
            Choice{' '}
            <select
              value={choice}
              onChange={(e) => {
                setChoice(Number(e.target.value));
                setCards([]);
              }}
            >
              {[1, 2, 3].map((c) => (
                <option key={c} value={c}>
                  {c} of 3{tiers[c - 1] ? ` · tier ${tiers[c - 1].normal} (rare ${tiers[c - 1].rare})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Re-rolls left{' '}
            <input
              type="number"
              min={0}
              max={3}
              value={rerolls}
              onChange={(e) => setRerollsLeft(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="row">
          {enemies.map((id, k) => (
            <select
              key={k}
              value={id}
              aria-label={`Enemy ${k + 1}`}
              onChange={(e) => setEnemies((es) => es.map((x, i) => (i === k ? Number(e.target.value) : x)))}
            >
              <option value={0}>enemy {k + 1}</option>
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          ))}
        </div>
        <div className="row">
          {!isElectron &&
            (capture === 'on' ? (
              <button className="btn" onClick={stopCapture}>
                Stop capture
              </button>
            ) : (
              <button className="btn primary" onClick={startCapture} disabled={capture === 'starting'}>
                Capture game screen + overlay
              </button>
            ))}
          {!isElectron && (
            <button className="btn" onClick={pip ? () => pip.close() : openPip}>
              {pip ? 'Close overlay' : hasDpip() ? 'Always-on-top overlay' : 'Advice window'}
            </button>
          )}
        </div>
        <div className="muted brawl-status" role="status" aria-live="polite">
          {status}
        </div>
      </div>

      {pip ? (
        createPortal(
          <div className="pip">
            <h2>
              {hero.name} · round {round}, choice {choice}
            </h2>
            {abilityOrder && abilityOrder.steps.length > 0 && (
              <div className="muted brawl-ability-line">
                {abilityOrder.steps.map((s, k) => (
                  <span key={k}>
                    {k > 0 ? ' ' : ''}
                    {k === abilityStepNow ? <b>{s.ability.name}</b> : s.ability.name}
                  </span>
                ))}
              </div>
            )}
            {capture === 'on' && (
              <canvas
                ref={previewRef}
                width={320}
                height={180}
                className="brawl-preview"
                aria-label="Draft screen with the recommended card boxed"
              />
            )}
            {advicePanel}
          </div>,
          pip.document.body,
        )
      ) : (
        <>
          {/* Electron already draws the box on the real game window via its own overlay; showing this
              preview here too would just duplicate it in the control window. */}
          {!isElectron && capture === 'on' && (
            <canvas
              ref={previewRef}
              width={320}
              height={180}
              className="brawl-preview"
              aria-label="Draft screen with the recommended card boxed"
            />
          )}
          {advicePanel}
        </>
      )}

      <div className="panel">
        <h2>Cards on screen</h2>
        <div className="muted">Filled in by the capture, or pick them here. Tick "enh." for an ENHANCED card.</div>
        <div className="row">
          {[0, 1, 2].map((k) => (
            <span key={k} className="brawl-pick">
              <select
                value={cards[k]?.itemId ?? 0}
                onChange={(e) => setCard(k, Number(e.target.value), !!cards[k]?.enhanced)}
              >
                <option value={0}>card {k + 1}</option>
                {catalog.map((i) => (
                  <option key={i.id} value={i.id}>
                    T{i.item_tier} {i.name}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={!!cards[k]?.enhanced}
                  onChange={(e) => cards[k] && setCard(k, cards[k].itemId, e.target.checked)}
                />{' '}
                enh.
              </label>
            </span>
          ))}
        </div>
      </div>

      {abilityOrder && abilityOrder.steps.length > 0 && (
        <div className="panel">
          <h2>Ability order</h2>
          {abilityOrder.support ? (
            <div className="muted">
              seen in {abilityOrder.support.matches} brawls, wins {(abilityOrder.support.winRate * 100).toFixed(0)}%
            </div>
          ) : (
            <div className="muted">no Street Brawl ability data for {hero.name} yet; fallback order shown</div>
          )}
          <ol className="brawl-ability-order">
            {abilityOrder.steps.map((s, k) => (
              <li key={k} className={k === abilityStepNow ? 'now' : ''}>
                {s.ability.name} <small>({s.kind === 'unlock' ? 'unlock' : s.kind})</small>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="panel">
        <h2>{hero.name}'s top items</h2>
        <div className="muted">Best pick in each tier, relative to the other items of that tier.</div>
        <div className="top-items">
          {topItems.map(({ tier, items }) => (
            <div key={tier} className="top-items-tier">
              <h3>Tier {tier}</h3>
              <div className="tiles">
                {items.map((b, k) => (
                  <ItemTile key={b.item.id} item={b.item} order={k + 1} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Owned ({owned.length})</h2>
        <div className="muted">
          {capture === 'on'
            ? 'Read from the inventory grid on the draft screen; tap to remove a mistake.'
            : 'Tap a card above when you take it; tap here to remove a mistake.'}
        </div>
        <div className="chips">
          {owned.map((id, k) => (
            <button key={k} className="chip" onClick={() => setOwned((o) => o.filter((_, i) => i !== k))}>
              {byId.get(id)?.name}
            </button>
          ))}
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              setOwned([]);
              setCards([]);
              setTook('');
              offeredRef.current = new Set();
              setRound(1);
              setChoice(1);
              setEnemies(Array<number>(ENEMY_SLOTS).fill(0));
            }}
          >
            New game
          </button>
        </div>
      </div>
      <div className="muted brawl-foot">
        <img src={img(hero.images.small)} alt="" /> Layout anchors are for 2560×1440; other 16:9 sizes scale. The
        capture only reads pixels. Run Deadlock in borderless windowed mode so the overlay stays on top of it
        (Chrome/Edge).
      </div>
    </div>
  );
}

const toOffer = (r: CardRead): Offer => ({ itemId: r.itemId, enhanced: r.enhanced });

interface AdvicePanelProps {
  input: BrawlInput | null;
  error: string | null;
  cards: Offer[];
  capture: 'off' | 'starting' | 'on';
  status: string;
  took_: string;
  owned: number[];
  ranked: RankedOffer[];
  reroll: RerollAdvice | null;
  rerolls: number;
  hero: Hero;
  took: (r: RankedOffer) => void;
  rerolled: () => void;
}

/** Split out so the loading/error state (shown while `input` is null, e.g. right after a hero change)
 *  never has to gate what renders above it in BrawlView — see the "never early-return before <video>" note. */
function AdvicePanel({
  input,
  error,
  cards,
  capture,
  status,
  took_,
  owned,
  ranked,
  reroll,
  rerolls,
  hero,
  took,
  rerolled,
}: AdvicePanelProps) {
  if (!input) {
    return (
      <div className="brawl-advice">
        {error ? <div className="error">{error}</div> : <div className="loading">Loading Street Brawl data…</div>}
      </div>
    );
  }
  return (
    <div className="brawl-advice">
      {!cards.length && (
        <div className="muted">
          {capture === 'on'
            ? status
            : 'No cards yet. Start the screen capture above, or pick the three cards yourself in "Cards on screen" below.'}
        </div>
      )}
      {took_ && (
        <div className="muted">
          Took {took_} · {owned.length} owned
        </div>
      )}
      {ranked.map((r, k) => (
        <button
          key={r.item.id}
          className={`brawl-card ${k === 0 ? 'best' : ''}`}
          onClick={() => took(r)}
          title={`score ${r.score.toFixed(2)} · ${
            capture === 'on' ? 'picks are read from the inventory grid; click only if it missed' : 'I took this one'
          }`}
        >
          <ItemTile item={r.item} />
          <span className="brawl-card-body">
            <b>
              {k === 0 ? 'TAKE' : `#${k + 1}`} {r.item.name}
              {r.enhanced ? ' (enhanced)' : ''}
            </b>
            <small>
              {k === 0 ? 'best' : `−${((1 - r.score / ranked[0].score) * 100).toFixed(0)}% vs best`} · used by{' '}
              {(r.usage * 100).toFixed(0)}% of {hero.name}s
              {r.winRate !== null ? `, wins ${(r.winRate * 100).toFixed(0)}%` : ''}
              {r.known ? '' : ' · no brawl data'}
            </small>
            {r.why.length > 0 && <small>{r.why.join('; ')}</small>}
          </span>
        </button>
      ))}
      {reroll && (
        <div className="brawl-reroll">
          Re-roll this set: best card {reroll.currentBest.toFixed(2)}, a fresh set should offer{' '}
          {reroll.expectedBest.toFixed(2)} (rare and enhanced slots stay rare and enhanced)
          {reroll.holdValue > 0 ? ` (saving it for a later set is worth ${reroll.holdValue.toFixed(2)})` : ''}{' '}
          <button className="btn" onClick={rerolled}>
            I re-rolled
          </button>
        </div>
      )}
      {cards.length > 0 && !reroll && <div className="muted">Keep this set{rerolls ? '' : ' (no re-rolls left)'}.</div>}
    </div>
  );
}
