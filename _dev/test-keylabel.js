'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const CORE = require('./core');
const PIPE = require('./pipeline');
const NP = 'C:/$SkyJot/$娱乐_游戏/AMinecraft/BE_网易工具/fast_bulid_7stars_admin/node_modules/@8crafter/leveldb-zlib';
const ZIP = 'C:/Users/SkyJot/Documents/WorkBuddy/建筑_网易我的世界直接导出压缩解密版本示例_网易基岩基岩测试.zip';

/* 与 app.js 里的 keyLabel 逐字一致（UI 层函数，这里复刻一份做验证） */
function keyLabel(k) {
  let odd = false;
  for (let i = 0; i < k.length; i++) { const c = k.charCodeAt(i); if (c < 0x20 || c > 0x7e) { odd = true; break; } }
  if (!odd) return null;
  const n = k.length;
  const at = o => (k.charCodeAt(o) | (k.charCodeAt(o + 1) << 8) | (k.charCodeAt(o + 2) << 16) | (k.charCodeAt(o + 3) << 24));
  const okC = v => v > -30000100 && v < 30000100;
  if (n === 9 || n === 10 || n === 13 || n === 14) {
    const x = at(0), z = at(4);
    const hasDim = n >= 13;
    const dim = hasDim ? at(8) : 0;
    const tag = k.charCodeAt(hasDim ? 12 : 8);
    if (okC(x) && okC(z) && (!hasDim || (dim >= -1 && dim <= 20)) && tag <= 0xff) {
      return '区块 ' + x + ', ' + z + (hasDim ? ' · 维度 ' + dim : '') + ' · tag 0x' + tag.toString(16).padStart(2, '0');
    }
  }
  let s = '';
  for (let i = 0; i < n && i < 40; i++) {
    const c = k.charCodeAt(i) & 0xff;
    s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '\\x' + c.toString(16).padStart(2, '0');
  }
  return s + (n > 40 ? '…' : '');
}

let fail = 0;
const ok = s => console.log('  [OK] ' + s);
const bad = s => { fail++; console.log('  [!!] ' + s); };

(async () => {
  console.log('== 1. keyLabel 语法自测（构造样本）==');
  const mk = (x, z, dim, tag) => {
    const b = Buffer.alloc(dim === null ? 9 : 13);
    b.writeInt32LE(x, 0); b.writeInt32LE(z, 4);
    if (dim !== null) { b.writeInt32LE(dim, 8); b[12] = tag; } else b[8] = tag;
    return b.toString('latin1');
  };
  const cases = [
    [mk(0, 0, 0, 0x2f), '区块 0, 0 · 维度 0 · tag 0x2f'],
    [mk(-3, 7, 1, 0x2b), '区块 -3, 7 · 维度 1 · tag 0x2b'],
    [mk(1234, -5678, 2, 0x76), '区块 1234, -5678 · 维度 2 · tag 0x76'],
    [mk(15, -15, null, 0x31), '区块 15, -15 · tag 0x31'],
    ['player_uid_3034284273', null],
    ['scoreboard', null]
  ];
  for (const [k, want] of cases) {
    const got = keyLabel(k);
    if (got === want) ok(JSON.stringify(want) + ' ← ' + (k.length > 20 ? '二进制 ' + k.length + 'B' : k));
    else bad('期望 ' + JSON.stringify(want) + '，得到 ' + JSON.stringify(got));
  }
  // 非区块的二进制 key 要转义
  const weird = '\x01\x02hello\x7f';
  keyLabel(weird) === '\\x01\\x02hello\\x7f' ? ok('非区块二进制转义成 \\xNN') : bad('转义不对：' + JSON.stringify(keyLabel(weird)));

  console.log('\n== 2. 真实存档里的区块 key ==');
  const raw = new Uint8Array(fs.readFileSync(ZIP));
  const files = await CORE.readZip(raw);
  const state = await PIPE.open(files, () => {});
  let chunk = 0, sample = null, untranslated = 0;
  for (const k of state.keys) {
    if (!/[\u0000-\u001f\u0080-\uffff]/.test(k)) continue;
    chunk++;
    const lbl = keyLabel(k);
    if (!lbl) untranslated++;
    if (!sample && lbl && /^区块 /.test(lbl)) sample = lbl;
  }
  console.log('  二进制 key 共 ' + chunk + ' 个，keyLabel 全部给出结果: ' + (untranslated === 0 ? '是' : '否（' + untranslated + ' 个返回 null）'));
  console.log('  样例: ' + sample);
  untranslated === 0 ? ok('没有漏网的二进制 key') : bad('有 ' + untranslated + ' 个没翻译');

  console.log('\n== 3. 完整导出闭环：改分数 → 打包 → 独立读回 ==');
  const sbRaw = state.map.get('scoreboard').value;
  const sb = CORE.nbtParseAuto(sbRaw);
  const objs = new Map(sb.root.v.entries).get('Objectives').v.items;
  const target = objs.find(o => CORE.nbtGet(o, 'Scores').v.items.length > 2);
  const tName = CORE.nbtGet(target, 'Name').v;
  const sid = CORE.nbtGet(CORE.nbtGet(target, 'Scores').v.items[0], 'ScoreboardId').v;
  CORE.nbtGet(CORE.nbtGet(target, 'Scores').v.items[0], 'Score').v = 424242;
  state.sb = { parsed: sb, dirty: true };
  console.log('  改「' + tName + '」里 ScoreboardId=' + sid + ' 的分数为 424242');

  const t1 = Date.now();
  const out = await PIPE.exportArchive(state, { name: 'sb.zip' });
  console.log('  导出 ' + (out.data.length / 1048576).toFixed(1) + ' MB，用时 ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv_'));
  const zf = await CORE.readZip(out.data);
  for (const f of zf) {
    if (/^db\//.test(f.name) || /(^|\/)CURRENT$/.test(f.name) || /MANIFEST/.test(f.name)) {
      fs.writeFileSync(path.join(tmp, f.name.replace(/^.*\//, '')), Buffer.from(CORE.decryptFile(f.name.replace(/^.*\//, ''), f.data)));
    }
  }
  const { LevelDB } = require(NP);
  const db = new LevelDB(tmp, { createIfMissing: false, compression: false });
  await db.open();
  const it = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
  let found = null, n = 0;
  for (;;) {
    const r = await it.next();
    if (!r) break;
    n++;
    const k = Buffer.from(r[1]).toString('latin1');
    if (k === 'scoreboard') { found = Buffer.from(r[0]); break; }
  }
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!found) { bad('导出包里找不到 scoreboard'); }
  else {
    const re = CORE.nbtParseAuto(new Uint8Array(found));
    const reObjs = new Map(re.root.v.entries).get('Objectives').v.items;
    const reObj = reObjs.find(o => CORE.nbtGet(o, 'Name').v === tName);
    const got = CORE.nbtGet(CORE.nbtGet(reObj, 'Scores').v.items[0], 'Score').v;
    got === 424242 ? ok('独立读回 scoreboard：分数 = ' + got) : bad('读回分数 ' + got + '，期望 424242');
    ok('扫到 scoreboard 时已路过 ' + n + ' 条（原库共 ' + state.stats.total + ' 条；此处只证明能按 key 定位）');
  }

  console.log('\n===== ' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
