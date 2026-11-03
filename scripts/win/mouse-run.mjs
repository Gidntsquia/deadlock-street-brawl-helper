// Run with Windows node (powershell). Reads the pointer settings (scripts/win/mouse.ps1) three times: app closed,
// app open, overlay shown, for the exe given as argv[2]. Writes the three readings and whether they match to argv[3].
// The overlay is made to show by turning test mode on over the Chrome DevTools protocol (--remote-debugging-port).
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [exe, out, label = 'app'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const exeName = path.basename(exe, '.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (phase) => {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(here, 'mouse.ps1'),
      '-Phase',
      phase,
      '-NamesCsv',
      exeName,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(r.stdout.trim());
};

const readings = [read('closed')];
const child = spawn(
  exe,
  ['--remote-debugging-port=9333', `--user-data-dir=${path.join(path.dirname(exe), '..', 'mouse-userdata')}`],
  { stdio: 'ignore' },
);
let targets = [];
for (let i = 0; i < 60 && !targets.length; i++) {
  await sleep(500);
  try {
    targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  } catch {}
}
await sleep(6000);
readings.push(read('open'));

async function evalIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => resolve(JSON.parse(m.data));
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  ws.close();
  return res.result?.result?.value;
}
const page = targets.find((t) => t.type === 'page' && !/overlay/i.test(t.url));
let clicked = null;
if (page) {
  clicked = await evalIn(
    page,
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/^show me$/i.test(x.textContent.trim())); if(!b) return 'no button'; b.click(); return b.textContent; })()`,
  );
}
let overlay = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const r = read('overlay');
  if (r.visible_app_windows.some((w) => /^\|/.test(w) || /overlay/i.test(w)) || r.visible_app_windows.length >= 3) {
    overlay = r;
    break;
  }
  overlay = r;
}
readings.push(overlay);
child.kill();
spawnSync('taskkill', ['/F', '/IM', `${exeName}.exe`, '/T']);
const key = (r) => JSON.stringify({ ...r, phase: 0, app_process_dpi_awareness: 0, visible_app_windows: 0 });
const identical = readings.every((r) => key(r) === key(readings[0]));
writeFileSync(out, JSON.stringify({ label, exe, testModeClick: clicked, identical, readings }, null, 2));
console.log(JSON.stringify({ label, identical, clicked, windows: overlay.visible_app_windows }));
