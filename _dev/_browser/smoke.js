'use strict';
/* 冒烟：打开存档 → 切六个页签 → 收集 JS 异常
 * 用法：node smoke.js <存档.zip 绝对路径>
 * 依赖：本机 Edge（可用 EDGE 环境变量指定路径）
 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = process.env.EDGE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge'
].find(p => fs.existsSync(p));
const PAGE = 'file:///' + path.resolve(__dirname, '..', '..', '存档编辑器.html')
  .replace(/\\/g, '/').split('/').map((s, i) => i === 0 ? s : encodeURIComponent(s)).join('/');
const ZIP = process.argv[2];
if (!ZIP || !fs.existsSync(ZIP)) {
  console.error('用法: node smoke.js <存档.zip 绝对路径>');
  process.exit(1);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const child = spawn(EDGE, ['--headless=new','--disable-gpu','--remote-debugging-port=9348','--user-data-dir='+profile,'about:blank'], {stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let t=null;
  for (let i=0;i<40;i++){await sleep(250);try{const j=await(await fetch('http://127.0.0.1:9348/json/list')).json();const p=j.find(x=>x.type==='page');if(p){t=p;break}}catch(e){}}
  const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const pend=new Map(); const errors=[];
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p||{}}))});
  ws.onmessage=e=>{const j=JSON.parse(e.data);
    if(j.id&&pend.has(j.id)){pend.get(j.id).res(j);pend.delete(j.id);return;}
    if(j.method==='Runtime.exceptionThrown') errors.push(j.params.exceptionDetails.text||'exception');
    if(j.method==='Log.entryAdded'&&j.params.entry.level==='error') errors.push(j.params.entry.text);
  };
  await new Promise(r=>ws.onopen=r);
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:PAGE}); await sleep(2200);
  const doc=await send('DOM.getDocument',{depth:-1});
  const q=await send('DOM.querySelector',{nodeId:doc.result.root.nodeId,selector:'#fileInput'});
  await send('DOM.setFileInputFiles',{nodeId:q.result.nodeId,files:[ZIP]});
  let ok=false;
  for(let i=0;i<120;i++){await sleep(500);const r=await send('Runtime.evaluate',{expression:"document.getElementById('ident').textContent.length",returnByValue:true});if(r.result.result.value>0){ok=true;break;}}
  console.log('解析完成:', ok);
  for (const tab of ['players','score','mods','world','data','overview']) {
    await send('Runtime.evaluate',{expression:`document.getElementById('tab-${tab}').click()`});
    await sleep(350);
  }
  const info=await send('Runtime.evaluate',{returnByValue:true,expression:`JSON.stringify({
    ident: document.getElementById('ident').innerText.replace(/\\n/g,' | '),
    stats: document.getElementById('stats').children.length,
    players: document.querySelectorAll('#plist tr').length,
    keys: document.querySelectorAll('#klist .krow').length,
    fmt: document.getElementById('fmtTag').textContent
  })`});
  console.log(info.result.result.value);
  console.log('JS 错误数:', errors.length, errors.slice(0,3).join(' / '));
  child.kill(); process.exit(0);
})().catch(e=>{console.error(e);child.kill();process.exit(1)});
