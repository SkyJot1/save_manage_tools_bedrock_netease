'use strict';
/* 找出横向溢出的元素（手机窄屏用） */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = process.env.EDGE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge'
].find(p => fs.existsSync(p));
const PAGE = process.argv[2];
const W = +(process.argv[3] || 390), H = +(process.argv[4] || 844);
const SETUP = process.argv[5] || '';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeprof-'));
const child = spawn(EDGE, ['--headless=new','--disable-gpu','--remote-debugging-port=9337',
  '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let t = null;
  for (let i=0;i<40;i++){ await sleep(250);
    try { const j = await (await fetch('http://127.0.0.1:9337/json/list')).json();
      const p = j.find(x=>x.type==='page'); if (p&&p.webSocketDebuggerUrl){t=p;break;} } catch(e){} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p||{}}))});
  ws.onmessage=ev=>{const j=JSON.parse(ev.data);if(j.id&&pend.has(j.id)){pend.get(j.id).res(j);pend.delete(j.id)}};
  await new Promise(r=>ws.onopen=r);
  await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:2,mobile:true});
  await send('Page.enable');
  await send('Page.navigate',{url:PAGE});
  await sleep(2200);
  if (SETUP) { await send('Runtime.evaluate',{expression:SETUP}); await sleep(600); }

  const EXPR = `(() => {
    const w = innerWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (r.right > w + 1 || r.left < -1) {
        const id = el.id ? '#'+el.id : '';
        const cls = el.className && typeof el.className === 'string' ? '.'+el.className.trim().split(/\\s+/).join('.') : '';
        bad.push({ sel: el.tagName.toLowerCase()+id+cls, L:+r.left.toFixed(0), R:+r.right.toFixed(0), W:+r.width.toFixed(0) });
      }
    });
    return {
      innerWidth: w,
      docScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      docScrollH: document.documentElement.scrollHeight,
      count: bad.length,
      items: bad.slice(0, 40)
    };
  })()`;
  const r = await send('Runtime.evaluate',{expression:EXPR,returnByValue:true});
  const v = r.result.result.value;
  console.log('视口 ' + v.innerWidth + ' / docScrollW ' + v.docScrollW + ' / bodyScrollW ' + v.bodyScrollW);
  console.log('溢出元素 ' + v.count + ' 个：');
  (v.items||[]).forEach(x => console.log('  ' + x.sel.padEnd(46) + ' L' + x.L + ' R' + x.R + ' W' + x.W));
  ws.close(); child.kill(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
