// Run with Windows node. Launches the exe with a Deadlock-titled dummy in front (no draft), patches setTimeout and
// setInterval in the main process (inspector, before any app code runs) and in every page (a preload that runs
// webFrame.executeJavaScript before the page's scripts), lets the app settle, then records every timer armed during the
// idle stretch. Writes the arms grouped by (process, kind, delay) to argv[3]. Pass: nothing re-arms faster than 5 s.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [exe, out, label = 'app', settleS = '25', windowS = '60'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ud = path.join(path.dirname(exe), '..', 'timers-userdata');
mkdirSync(ud, { recursive: true });
const preload = path.join(ud, 'timer-preload.cjs');
const PATCH = `(() => {
  if (globalThis.__arms) return;
  const arms = (globalThis.__arms = []);
  const t0 = Date.now();
  const live = (globalThis.__live = new Map());
  const oSet = globalThis.setInterval, oClear = globalThis.clearInterval;
  globalThis.setInterval = function (fn, ms, ...rest) {
    const h = oSet.call(this, fn, ms, ...rest);
    arms.push({ at: Date.now() - t0, kind: 'interval', delay: Number(ms) || 0 });
    live.set(h, Number(ms) || 0);
    return h;
  };
  globalThis.clearInterval = function (h) { live.delete(h); return oClear.call(this, h); };
  for (const [name, kind] of [['setTimeout', 'timeout']]) {
    const orig = globalThis[name];
    globalThis[name] = function (fn, ms, ...rest) {
      arms.push({ at: Date.now() - t0, kind, delay: Number(ms) || 0 });
      return orig.call(this, fn, ms, ...rest);
    };
  }
})();`;
writeFileSync(
  preload,
  `try { require('electron').webFrame.executeJavaScript(${JSON.stringify(PATCH)}); } catch (e) {}\n`,
);

const dummy = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(here, 'perf-dummy.ps1'),
    '-Seconds',
    String(Number(settleS) + Number(windowS) + 50),
  ],
  { stdio: 'ignore' },
);
await sleep(3000);
const child = spawn(exe, ['--inspect-brk=9230', '--remote-debugging-port=9333', `--user-data-dir=${ud}`], {
  stdio: 'ignore',
});

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const listeners = {};
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
    else if (d.method && listeners[d.method]) listeners[d.method](d.params);
  };
  return {
    send: (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    on: (m, f) => (listeners[m] = f),
    close: () => ws.close(),
  };
}
let targets = [];
for (let i = 0; i < 60 && !targets.length; i++) {
  await sleep(500);
  try {
    targets = await (await fetch('http://127.0.0.1:9230/json')).json();
  } catch {}
}
const main = await connect(targets[0].webSocketDebuggerUrl);
const mainPatch = `(() => {
  ${PATCH.replace(/globalThis/g, 'globalThis')}
  import('electron').then((m) => {
    const { app, session } = m.default ?? m;
    app.whenReady().then(() => session.defaultSession.setPreloads([${JSON.stringify(preload)}]));
  });
  return typeof globalThis.__arms;
})()`;
const paused = new Promise((r) => main.on('Debugger.paused', r));
await main.send('Debugger.enable');
await main.send('Runtime.runIfWaitingForDebugger');
const pz = await paused;
const r1 = await main.send('Debugger.evaluateOnCallFrame', {
  callFrameId: pz.callFrames[0].callFrameId,
  expression: mainPatch,
  returnByValue: true,
});
await main.send('Debugger.resume');
const patched = r1.result?.result?.value ?? JSON.stringify(r1.result?.exceptionDetails ?? r1.result);

await sleep(Number(settleS) * 1000);
const mark = async () => {
  const m = await main.send('Runtime.evaluate', { expression: 'globalThis.__arms.length', returnByValue: true });
  return m.result?.result?.value ?? 0;
};
const mainFrom = await mark();
console.log('mainFrom', mainFrom);
const pages = await (await fetch('http://127.0.0.1:9333/json')).json();
const pageConns = [];
for (const p of pages.filter((x) => x.type === 'page')) {
  const c = await connect(p.webSocketDebuggerUrl);
  const n = await c.send('Runtime.evaluate', { expression: '(window.__arms||[]).length', returnByValue: true });
  pageConns.push({ c, url: p.url, from: n.result?.result?.value ?? 0 });
}
await sleep(Number(windowS) * 1000);
const group = (arms) => {
  const g = new Map();
  for (const a of arms) {
    const k = `${a.kind}:${a.delay}`;
    g.set(k, (g.get(k) ?? 0) + 1);
  }
  return [...g.entries()]
    .map(([k, count]) => ({ timer: k, count }))
    .sort((a, b) => Number(a.timer.split(':')[1]) - Number(b.timer.split(':')[1]));
};
const res = { label, exe, settle_s: Number(settleS), window_s: Number(windowS), main_patched: patched, processes: {} };
const ma = await main.send('Runtime.evaluate', {
  expression: `JSON.stringify(globalThis.__arms.slice(${mainFrom}))`,
  returnByValue: true,
});
res.main_total_arms = JSON.parse(ma.result?.result?.value ?? '[]').length;
res.main_from = mainFrom;
res.main_raw = JSON.stringify(ma.result).slice(0, 300);
res.processes.main = group(JSON.parse(ma.result?.result?.value ?? '[]'));
let i = 0;
for (const pc of pageConns) {
  const pa = await pc.c.send('Runtime.evaluate', {
    expression: `JSON.stringify((window.__arms||[]).slice(${pc.from}))`,
    returnByValue: true,
  });
  res.processes[`page${i++}:${pc.url.split('/').pop().split('?')[0]}`] = group(
    JSON.parse(pa.result?.result?.value ?? '[]'),
  );
}
const liveOf = async (conn, expr) => {
  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return JSON.parse(r.result?.result?.value ?? '[]');
};
const LIVE = 'JSON.stringify([...(globalThis.__live ? globalThis.__live.values() : [])])';
res.live_intervals_ms = { main: await liveOf(main, LIVE) };
for (const [k, pc] of pageConns.entries()) res.live_intervals_ms[`page${k}`] = await liveOf(pc.c, LIVE);
const fast = [];
for (const [proc, ds] of Object.entries(res.live_intervals_ms))
  for (const d of ds) if (d < 5000) fast.push({ proc, timer: `live interval:${d}` });
for (const [proc, rows] of Object.entries(res.processes)) {
  for (const r of rows) {
    const delay = Number(r.timer.split(':')[1]);
    const rate = r.count / Number(windowS);
    if (delay < 5000 && r.count > 1)
      fast.push({ proc, timer: r.timer, armed: r.count, per_s: Math.round(rate * 100) / 100 });
  }
}
res.armed_faster_than_5s_more_than_once = fast;
res.pass = fast.length === 0;
child.kill();
dummy.kill();
spawnSync('taskkill', ['/F', '/IM', path.basename(exe), '/T']);
writeFileSync(out, JSON.stringify(res, null, 2));
console.log(JSON.stringify({ label, main_patched: patched, pass: res.pass, fast }));
