'use strict';
/* 内核自测：读取 → NBT 往返 → 重建库 → 用 leveldb-zlib 复核 → ZIP */
const fs = require('fs');
const path = require('path');
const os = require('os');
const CORE = require('./core');

const NP = 'C:/$SkyJot/$娱乐_游戏/AMinecraft/BE_网易工具/fast_bulid_7stars_admin/node_modules/@8crafter/leveldb-zlib';

function loadDir(dir) {
  const files = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (!fs.statSync(p).isFile()) continue;
    if (n === 'LOCK') continue;
    files.push({ name: n, data: new Uint8Array(fs.readFileSync(p)) });
  }
  return files;
}

async function readWithLib(dir) {
  const { LevelDB } = require(NP);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v_'));
  const names = fs.readdirSync(dir).filter(n => n !== 'LOCK');
  for (const n of names) {
    const p = path.join(dir, n);
    if (!fs.statSync(p).isFile()) continue;
    fs.writeFileSync(path.join(tmp, n), CORE.decryptFile(n, new Uint8Array(fs.readFileSync(p))));
  }
  const db = new LevelDB(tmp, { createIfMissing: false, compression: false });
  await db.open();
  const it = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
  const out = new Map();
  for (;;) {
    const r = await it.next();
    if (!r) break;
    out.set(Buffer.from(r[1]).toString('latin1'), Buffer.from(r[0]));
  }
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

(async () => {
  const dbDir = process.argv[2];
  console.log('=== 1. 读库（纯 JS）===');
  const t0 = Date.now();
  const files = loadDir(dbDir);
  const map = await CORE.readDatabase(files);
  console.log('  键数:', map.size, ' 耗时', Date.now() - t0, 'ms');

  console.log('=== 2. 与 leveldb-zlib 对读 ===');
  const ref = await readWithLib(dbDir);
  let diff = 0, onlyA = 0, onlyB = 0;
  for (const [k, v] of map) {
    const r = ref.get(k);
    if (!r) { onlyA++; continue; }
    if (!CORE.eqBytes(v.value, new Uint8Array(r))) diff++;
  }
  for (const k of ref.keys()) if (!map.has(k)) onlyB++;
  console.log('  参考键数:', ref.size, ' 值不同:', diff, ' 只在纯JS:', onlyA, ' 只在参考:', onlyB);

  console.log('=== 3. NBT 往返 ===');
  let players = 0, parsed = 0, roundOK = 0, failList = [];
  const editor = new Map();
  for (const [k, v] of map) {
    if (!/^player_uid_|^~local_player$|^scoreboard$/.test(k)) continue;
    if (k === 'scoreboard') continue;
    players++;
    let p;
    try { p = CORE.nbtParseAuto(v.value); } catch (e) { failList.push(k + ': ' + e.message); continue; }
    parsed++;
    const out = CORE.nbtWrite(p.root, p.name, p.longNames);
    if (CORE.eqBytes(out, v.value)) roundOK++;
    else if (failList.length < 6) failList.push(k + ': 往返不一致 ' + out.length + '/' + v.value.length);
    editor.set(k, p);
  }
  console.log('  玩家记录:', players, ' 解析成功:', parsed, ' 字节完全相同:', roundOK);
  failList.slice(0, 8).forEach(x => console.log('    ! ' + x));

  console.log('=== 4. 字段抽样 ===');
  const sample = editor.get([...editor.keys()].find(k => /^player_uid_/.test(k)));
  if (sample) {
    const fields = sample.root.v.entries;
    console.log('  顶层字段数:', fields.length);
    const health = CORE.nbtGet(sample.root, 'Attributes');
    console.log('  Attributes 项数:', health ? health.v.items.length : 0);
    if (health) {
      health.v.items.slice(0, 6).forEach(it => {
        const name = CORE.nbtGet(it, 'Name');
        const cur = CORE.nbtGet(it, 'Current');
        const max = CORE.nbtGet(it, 'Max');
        console.log('    ' + (name ? name.v : '?') + ' = ' + (cur ? cur.v : '?') + ' / ' + (max ? max.v : '?'));
      });
    }
    const tags = CORE.nbtGet(sample.root, 'Tags');
    console.log('  Tags:', tags ? JSON.stringify(tags.v.items.map(x => x.v)) : '无');
    const inv = CORE.nbtGet(sample.root, 'Inventory');
    console.log('  Inventory 件数:', inv ? inv.v.items.length : 0);
    const lvl = CORE.nbtGet(sample.root, 'PlayerLevel');
    console.log('  PlayerLevel:', lvl && lvl.v);
  }

  console.log('=== 5. 重建整库并复核 ===');
  const t1 = Date.now();
  const entries = [];
  for (const [k, v] of map) entries.push({ key: CORE.asciiBytes(k), value: v.value });
  const outFiles = await CORE.buildDatabase(entries, {});
  let total = 0;
  for (const f of outFiles) total += f.data.length;
  console.log('  生成文件:', outFiles.length, ' 合计', (total / 1048576).toFixed(1), 'MB  耗时', Date.now() - t1, 'ms');
  console.log('  ' + outFiles.map(f => f.name + '(' + (f.data.length / 1048576).toFixed(1) + 'M)').join(' '));

  const outDir = path.join(__dirname, '_out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of outFiles) fs.writeFileSync(path.join(outDir, f.name), Buffer.from(f.data));

  const t2 = Date.now();
  const back = await readWithLib(outDir);
  console.log('  leveldb-zlib 读回:', back.size, ' 耗时', Date.now() - t2, 'ms');
  let bad = 0, miss = 0, extra = 0;
  for (const [k, v] of map) {
    const r = back.get(k);
    if (!r) { miss++; continue; }
    if (!CORE.eqBytes(v.value, new Uint8Array(r))) bad++;
  }
  for (const k of back.keys()) if (!map.has(k)) extra++;
  console.log('  值不同:', bad, ' 丢失:', miss, ' 多出:', extra);
  console.log(bad === 0 && miss === 0 && extra === 0 ? '  ✅ 重建库与原始逻辑内容完全一致' : '  ❌ 有差异');
})().catch(e => { console.error('ERR', e); process.exit(1); });
