'use strict';
/* 用 CDP 强制 390x844 设备尺寸截图，验证移动端布局 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.EDGE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge'
].find(p => fs.existsSync(p));
const PAGE = process.argv[2];
const OUT = process.argv[3] || path.join(os.tmpdir(), 'shot', 'm.png');
const W = +(process.argv[4] || 390);
const H = +(process.argv[5] || 844);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeprof-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9333',
  '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let list = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:9333/json/list');
      const j = await r.json();
      const p = j.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) { list = p; break; }
    } catch (e) { }
  }
  if (!list) throw new Error('连不上 CDP');

  const ws = new WebSocket(list.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.navigate', { url: PAGE });
  await sleep(2500);

  // 量一下真实尺寸与溢出
  const ev = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const de = document.documentElement, b = document.body;
      const wide = [];
      document.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > de.clientWidth + 2 && r.height > 0) {
          wide.push(el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' w=' + Math.round(r.width));
        }
      });
      const hb = [...document.querySelectorAll('header button')].map(b => Math.round(b.getBoundingClientRect().width));
      return {
        innerWidth: window.innerWidth, docW: de.clientWidth, scrollW: de.scrollWidth,
        bodyScrollW: b.scrollWidth, headerBtns: hb,
        overflow: wide.slice(0, 12),
      };
    })()`,
  });
  console.log('尺寸自检:', JSON.stringify(ev.result.value, null, 1));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已存 ' + OUT);

  ws.close();
  child.kill();
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); child.kill(); process.exit(1); });
