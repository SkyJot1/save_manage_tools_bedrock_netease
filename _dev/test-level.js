'use strict';
/* level.dat 编辑闭环：改规则 → 导出 → 独立读回校验 */
const fs = require('fs');
const CORE = require('./core');
const PIPE = require('./pipeline');
const ZIP = 'C:/Users/SkyJot/Documents/WorkBuddy/建筑_网易我的世界直接导出压缩解密版本示例_网易基岩基岩测试.zip';

let fail = 0;
const ok = s => console.log('  [OK] ' + s);
const bad = s => { fail++; console.log('  [!!] ' + s); };

(async () => {
  const raw = new Uint8Array(fs.readFileSync(ZIP));
  const files = await CORE.readZip(raw);
  const state = await PIPE.open(files, () => {});
  const ld = state.levelDat;
  const r = ld.parsed.root;
  console.log('level.dat 原始 ' + ld.file.data.length + ' 字节，头写长度 ' + ld.length);

  const before = {
    pvp: CORE.nbtGet(r, 'pvp').v,
    keep: CORE.nbtGet(r, 'keepinventory').v,
    name: CORE.nbtGet(r, 'LevelName').v,
    keys: r.v.entries.length
  };
  console.log('改前：pvp=' + before.pvp + ' keepinventory=' + before.keep + ' LevelName=' + JSON.stringify(before.name));

  // 模拟界面操作：直接改节点
  CORE.nbtGet(r, 'pvp').v = 0;
  CORE.nbtGet(r, 'keepinventory').v = 0;
  PIPE.setStr(CORE.nbtGet(r, 'LevelName'), '改过的世界');
  ld.dirty = true;

  const t0 = Date.now();
  const out = await PIPE.exportArchive(state, { name: 'lv.zip' });
  console.log('导出 ' + (out.data.length / 1048576).toFixed(1) + ' MB，' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

  const zf = await CORE.readZip(out.data);
  const f = zf.find(x => /(^|\/)level\.dat$/i.test(x.name));
  if (!f) { bad('导出包里找不到 level.dat'); return; }
  console.log('包内路径 ' + f.name + '，' + f.data.length + ' 字节');

  const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
  const ver = dv.getInt32(0, true);
  const hlen = dv.getInt32(4, true);
  const real = f.data.length - 8;
  hlen === real ? ok('头部长度 ' + hlen + ' = 实际正文 ' + real) : bad('头部长度 ' + hlen + ' ≠ 实际 ' + real);
  ver === 10 ? ok('版本号 ' + ver) : bad('版本号变了：' + ver);

  const back = CORE.nbtParseAuto(f.data.subarray(8));
  back.end === real ? ok('NBT 正好收尾 ' + back.end + '/' + real) : bad('收尾不对 ' + back.end + '/' + real);
  const rb = back.root;
  CORE.nbtGet(rb, 'pvp').v === 0 ? ok('pvp 写回 = 0') : bad('pvp = ' + CORE.nbtGet(rb, 'pvp').v);
  CORE.nbtGet(rb, 'keepinventory').v === 0 ? ok('keepinventory 写回 = 0') : bad('keepinventory 没改到');
  CORE.nbtGet(rb, 'LevelName').v === '改过的世界' ? ok('世界名写回 = 改过的世界') : bad('世界名 = ' + CORE.nbtGet(rb, 'LevelName').v);
  rb.v.entries.length === before.keys ? ok('顶层键数不变 ' + before.keys) : bad('键数 ' + before.keys + ' → ' + rb.v.entries.length);

  // 其他键不能被动
  const rules = ['dodaylightcycle', 'domobspawning', 'tntexplodes', 'naturalregeneration'];
  let same = 0;
  for (const k of rules) {
    const a = CORE.nbtGet(r, k).v, b = CORE.nbtGet(rb, k).v;
    if (a === b) same++;
    else console.log('    ! ' + k + ' ' + a + ' → ' + b);
  }
  same === rules.length ? ok('抽样 ' + rules.length + ' 条规则原样保留') : bad((rules.length - same) + ' 条规则被波及');

  // 再次打开这个包，确认能读
  const st2 = await PIPE.open(zf, () => {});
  st2.levelDat && CORE.nbtGet(st2.levelDat.parsed.root, 'LevelName').v === '改过的世界'
    ? ok('导出的包能被本工具重新打开，世界名是新值')
    : bad('导出的包重新打开失败');

  console.log('\n===== ' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
