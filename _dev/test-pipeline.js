'use strict';
/* 端到端测试：开 zip → 解析 → 改一个玩家 → 导出 → 用 leveldb-zlib 复核 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const CORE = require('./core');
const PIPE = require('./pipeline');

const NP = 'C:/$SkyJot/$娱乐_游戏/AMinecraft/BE_网易工具/fast_bulid_7stars_admin/node_modules/@8crafter/leveldb-zlib';

async function verify(zipData, expectCount) {
  const files = await CORE.readZip(zipData);
  const layout = PIPE.detectLayout(files);
  const fmt = PIPE.detectFormat(layout.dbFiles);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ez_'));
  for (const f of layout.dbFiles) {
    fs.writeFileSync(path.join(tmp, f.name), Buffer.from(CORE.decryptFile(f.name, f.data)));
  }
  const { LevelDB } = require(NP);
  const db = new LevelDB(tmp, { createIfMissing: false, compression: false });
  await db.open();
  const it = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
  let n = 0;
  const keep = new Map();
  for (;;) {
    const r = await it.next();
    if (!r) break;
    n++;
    const k = Buffer.from(r[1]).toString('latin1');
    if (/^player_uid_/.test(k)) keep.set(k, Buffer.from(r[0]));
  }
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return { n, fmt, keep, files };
}

(async () => {
  const zipPath = process.argv[2];
  const raw = new Uint8Array(fs.readFileSync(zipPath));
  console.log('=== 1. 读 ZIP ===');
  const t0 = Date.now();
  const files = await CORE.readZip(raw);
  console.log('  文件:', files.length, '耗时', Date.now() - t0, 'ms');
  console.log('  样例:', files.slice(0, 5).map(f => f.name + '(' + (f.data.length / 1024 | 0) + 'K)').join(' '));

  console.log('=== 2. 打开存档 ===');
  const t1 = Date.now();
  const state = await PIPE.open(files, (s, p) => { if (/完成|分类/.test(s)) console.log('  ' + s); });
  console.log('  格式:', state.format, ' 前缀:', JSON.stringify(state.layout.prefix));
  console.log('  键数:', state.stats.total, ' NBT 值:', state.stats.nbt, ' 玩家:', state.stats.player);
  console.log('  分类:', JSON.stringify(state.stats.byCat));
  console.log('  耗时:', Date.now() - t1, 'ms');

  console.log('=== 3. 玩家列表前 5 ===');
  state.players.slice(0, 5).forEach(p => {
    const d = PIPE.readPlayer(p);
    console.log('  ' + (d.nick || '(无昵称)').slice(0, 14) + '  uid=' + d.uid + ' 等级=' + d.level +
      ' 生命=' + d.health + ' 坐标=' + [d.x, d.y, d.z].map(v => v && v.toFixed(1)).join(',') +
      ' 背包=' + d.invCount + ' tag=' + JSON.stringify(d.tags));
  });

  console.log('=== 4. 改一个玩家，导出 ===');
  const target = state.players.find(p => {
    const d = PIPE.readPlayer(p);
    return d.uid && d.uid.length > 5;
  });
  const before = PIPE.readPlayer(target);
  const r = target.parsed.root;
  // 生命设成 7，等级 +5，坐标挪 1 格
  const hp = (function () {
    const list = CORE.nbtGet(r, 'Attributes');
    for (const it of list.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === 'minecraft:health') return it;
    }
  })();
  CORE.nbtGet(hp, 'Current').v = 7;
  CORE.nbtGet(r, 'PlayerLevel').v = (CORE.nbtGet(r, 'PlayerLevel').v || 0) + 5;
  CORE.nbtGet(r, 'Pos').v.items[1].v = CORE.nbtGet(r, 'Pos').v.items[1].v + 1;
  target.dirty = true;
  console.log('  目标:', before.nick || before.uid, ' 生命 20→7 等级', before.level, '→', before.level + 5);

  const t2 = Date.now();
  const out = await PIPE.exportArchive(state, { name: 'test_edited.zip' });
  console.log('  导出大小:', (out.data.length / 1048576).toFixed(1), 'MB  耗时', Date.now() - t2, 'ms');
  fs.writeFileSync(path.join(__dirname, '_out_edited.zip'), Buffer.from(out.data));

  console.log('=== 5. 复核导出的 zip ===');
  const t3 = Date.now();
  const v = await verify(out.data);
  console.log('  读回键数:', v.n, ' 耗时', Date.now() - t3, 'ms');
  const expect = state.stats.total;
  console.log('  键数一致:', v.n === expect ? '✅ ' + expect : '❌ ' + v.n + ' vs ' + expect);
  const k = target.key;
  const got = v.keep.get(k);
  if (!got) { console.log('  ❌ 找不到目标玩家'); return; }
  const re = CORE.nbtParseAuto(new Uint8Array(got));
  const h2 = (function () {
    const list = CORE.nbtGet(re.root, 'Attributes');
    for (const it of list.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === 'minecraft:health') return it;
    }
  })();
  console.log('  导出的玩家: 生命', CORE.nbtGet(h2, 'Current').v, ' 等级', CORE.nbtGet(re.root, 'PlayerLevel').v,
    ' Y', CORE.nbtGet(re.root, 'Pos').v.items[1].v.toFixed(3));
  console.log('  其它玩家条数:', v.keep.size, '（原', state.stats.player, '）');
})().catch(e => { console.error('ERR', e); process.exit(1); });
