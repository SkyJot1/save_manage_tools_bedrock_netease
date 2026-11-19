'use strict';
/* 端到端：把 world.zip 塞进「选择压缩包」输入框，等解析完，截概览页并检查鉴别卡 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const EDGE = process.env.EDGE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge'
].find(p => fs.existsSync(p));
const PAGE = 'file:///C:/Users/SkyJot/Documents/WorkBuddy/2026-10-27-12-52-58/%E5%BF%AB%E5%BB%BA%E6%9D%83%E9%99%90%E5%B7%A5%E5%85%B7_%E4%BF%AE%E5%A4%8D/%E5%AD%98%E6%A1%A3%E7%BC%96%E8%BE%91%E5%99%A8.html';
const ZIP = process.argv[4];
if (!ZIP) { console.error('用法: node ident-test.js <宽> <高> <存档.zip 绝对路径> <输出.png>'); process.exit(1); }
const OUT = path.join(__dirname, process.argv[5] || 'ident.png');
const W = +(process.argv[2] || 1280), H = +(process.argv[3] || 860);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeprof-'));
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9341',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { const j = await (await fetch('http://127.0.0.1:9341/json/list')).json(); const p = j.find(x => x.type === 'page'); if (p && p.webSocketDebuggerUrl) { t = p; break; } } catch (e) { }
  }
  if (!t) throw new Error('没连上调试端口');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const j = JSON.parse(ev.data); if (j.id && pend.has(j.id)) { pend.get(j.id).res(j); pend.delete(j.id); } };
  await new Promise(r => ws.onopen = r);

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(2500);

  // 找到 file input，塞文件
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [ZIP] });

  // 等解析完成（#ident 有内容）
  let ok = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: "document.getElementById('ident').textContent.length", returnByValue: true });
    if (r.result && r.result.result && r.result.result.value > 0) { ok = true; break; }
  }
  console.log('ident 出现:', ok);
  await sleep(600);

  const dump = await send('Runtime.evaluate', {
    expression: `(()=>{
      const b=document.getElementById('ident');
      const cs=getComputedStyle(b);
      return JSON.stringify({
        text: b.textContent,
        cls: b.className,
        h: b.getBoundingClientRect().height,
        scrollW: b.scrollWidth, clientW: b.clientWidth,
        overflowX: cs.overflowX,
        docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth
      });
    })()`, returnByValue: true
  });
  console.log(dump.result.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', OUT);

  child.kill();
  process.exit(0);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
