/* 导出产物的 LevelDB 格式验收
 * 这一组检查是补上之前漏掉的那一层：以前只验证「我们自己的读器能读回来」，
 * 而自研读器是顺序扫描，既不校验块尾 CRC，也不走 restart 数组的二分查找，
 * 所以库里有两个致命错误也照样「通过」。这里改为按 leveldb 的读取路径验收。
 *
 * 必过项：
 *   1. 对照组（原始存档）0 结构错误 —— 校验器本身不能误报
 *   2. 未改动直接导出：0 结构错误
 *   3. 改数据后导出（长度变化）：0 结构错误
 *   4. 每个块的块尾都是掩码后 CRC（游戏里的 BlockReader 会校验，不匹配直接当损坏）
 *   5. 每个 restart 偏移都落在 shared=0 的记录上（否则 Seek 判损坏）
 */
'use strict';
const fs = require('fs');
const CORE = require('./core');
const PIPE = require('./pipeline');
const LV = require('./lvcheck');
const ZIP = 'C:/Users/SkyJot/Documents/WorkBuddy/建筑_网易我的世界直接导出压缩解密版本示例_网易基岩基岩测试.zip';

let fail = 0;
const ok = s => console.log('  [OK] ' + s);
const bad = s => { fail++; console.log('  [!!] ' + s); };

async function check(tag, dbFiles) {
  const res = LV.checkDatabase(dbFiles, CORE);
  // 顺带跑一遍产品代码里的深度自检，确认它和独立校验器结论一致
  if (res) {
    const plain = dbFiles.map(f => ({ name: f.name, data: CORE.decryptFile(f.name, f.data) }));
    const deep = await CORE.verifyDatabase(plain, null, { full: true });
    if (deep.ok) ok(tag + '：产品自检（deep）也通过 ' + deep.blocks + ' 块 / ' + deep.keys + ' 条');
    else { bad(tag + '：产品自检（deep）报出 ' + deep.problems.length + ' 处问题'); deep.problems.slice(0, 5).forEach(x => console.log('       ' + x)); }
  }
  const errs = [];
  res.ssts.forEach(s => s.errs.forEach(e => errs.push(e)));
  res.manifestErrs.forEach(e => errs.push('[MANIFEST] ' + e));
  if (!errs.length) ok(tag + '：' + res.sstCount + ' 个 SST / ' + res.keys + ' 条记录 / 0 结构错误');
  else {
    bad(tag + '：' + errs.length + ' 处结构错误');
    errs.slice(0, 5).forEach(e => console.log('       ' + e));
  }
  return res;
}

async function exportAndCheck(state, tag, mutate) {
  if (mutate) mutate(state);
  const out = await PIPE.exportArchive(state, { name: tag + '.zip' });
  const zf = await CORE.readZip(out.data);
  const db = zf.filter(f => /(^|\/)db\//.test(f.name)).map(f => ({ name: f.name.replace(/^.*\//, ''), data: f.data }));
  const res = await check(tag, db);
  return { out, db, res, files: zf };
}

(async () => {
  const raw = new Uint8Array(fs.readFileSync(ZIP));
  const files = await CORE.readZip(raw);
  const state = await PIPE.open(files, () => {});

  console.log('== 0. CRC32C 实现自检 ==');
  CORE.crc32c(CORE.asciiBytes('123456789')) === 0xe3069283
    ? ok('crc32c("123456789") = 0xe3069283（标准向量）')
    : bad(' CRC32C 实现不对，后面所有结论都不作数');

  console.log('\n== 1. 对照组：原始存档 ==');
  await check('原始存档', state.layout.dbFiles);

  console.log('\n== 2. 未改动直接导出 ==');
  const r1 = await exportAndCheck(state, '原样导出');
  console.log('     产物 ' + (r1.out.data.length / 1048576).toFixed(1) + ' MB');

  console.log('\n== 3. 改数据后导出（记录长度会变） ==');
  const r2 = await exportAndCheck(state, '改数据导出', st => {
    const p = st.players[0];
    const list = CORE.nbtGet(p.parsed.root, 'Attributes');
    for (const it of list.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === 'minecraft:health') CORE.nbtGet(it, 'Current').v = 19;
    }
    p.dirty = true;
    const ld = st.levelDat;
    if (ld) { PIPE.setStr(CORE.nbtGet(ld.parsed.root, 'LevelName'), '格式验收用的一个比较长的世界名字'); ld.dirty = true; }
  });

  console.log('\n== 4. 逐块检查掩码 CRC 与 restart ==');
  let blocks = 0, crcBad = 0, restartBad = 0;
  for (const s of r1.res.ssts.concat(r2.res.ssts)) {
    for (const e of s.errs) {
      if (/CRC/.test(e)) crcBad++;
      if (/restart/.test(e)) restartBad++;
    }
  }
  for (const s of r1.res.ssts) blocks += s.blocks;
  crcBad === 0 ? ok('块尾 CRC 全部是掩码值（' + blocks + ' 个数据块 + index/meta）') : bad(crcBad + ' 个块 CRC 不对');
  restartBad === 0 ? ok('restart 数组全部指向 shared=0 的记录') : bad(restartBad + ' 处 restart 越界或前缀不为 0');

  console.log('\n== 5. 索引与键序 ==');
  const seek = r1.res.ssts.reduce((a, s) => a + s.seekFail, 0);
  seek === 0 ? ok('每块首/中/末三条做 Seek 模拟，全部命中') : bad(seek + ' 次 Seek 失败');

  console.log('\n== 6. level.dat 头长度 ==');
  const lv2 = r2.files.find(f => /level\.dat$/.test(f.name));
  if (lv2) {
    const dv = new DataView(lv2.data.buffer, lv2.data.byteOffset, lv2.data.byteLength);
    const hlen = dv.getInt32(4, true);
    hlen === lv2.data.length - 8 ? ok('头写长度 ' + hlen + ' = 正文 ' + (lv2.data.length - 8)) : bad('头长度 ' + hlen + ' ≠ ' + (lv2.data.length - 8));
  } else bad('导出包里没有 level.dat');

  console.log('\n===== ' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
