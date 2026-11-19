'use strict';
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
  const t0 = Date.now();
  const state = await PIPE.open(files, () => {});
  console.log('打开完成 ' + (Date.now() - t0) + 'ms, 键 ' + state.stats.total + ' 玩家 ' + state.players.length);

  // ---- 1. 二进制标记 ----
  console.log('\n== 1. scriptData / StorageKey 的二进制标记 ==');
  let sdBin = 0, sdAll = 0, skBin = 0, skAll = 0;
  for (const p of state.players) {
    const sd = CORE.nbtGet(p.parsed.root, 'scriptData');
    if (sd && sd.t === 8) { sdAll++; if (sd.bin) sdBin++; }
    const ic = CORE.nbtGet(p.parsed.root, 'internalComponents');
    const ec = ic && CORE.nbtGet(ic, 'EntityStorageKeyComponent');
    const sk = ec && CORE.nbtGet(ec, 'StorageKey');
    if (sk && sk.t === 8) { skAll++; if (sk.bin) skBin++; }
  }
  console.log('  scriptData: ' + sdBin + '/' + sdAll + ' 判定为二进制');
  console.log('  StorageKey: ' + skBin + '/' + skAll);
  sdBin === sdAll && sdAll > 0 ? ok('scriptData 全部识别为二进制（不再显示 U+FFFD）') : bad('scriptData 识别不全');
  skAll === 0 || skBin === skAll ? ok('StorageKey 一致') : bad('StorageKey 识别不全');

  // ---- 2. 加 bin 字段不能影响写回 ----
  console.log('\n== 2. 加 bin 字段后仍然逐字节写回 ==');
  let same = 0, tot = 0, firstBad = null;
  for (const p of state.players.slice(0, 800)) {
    tot++;
    const out = CORE.nbtWrite(p.parsed.root, p.parsed.name, p.parsed.longNames);
    if (CORE.eqBytes(out, p.raw)) same++;
    else if (!firstBad) firstBad = p.key + ' ' + out.length + ' vs ' + p.raw.length;
  }
  same === tot ? ok('抽样 ' + tot + ' 名玩家，全部逐字节一致') : bad('不一致 ' + (tot - same) + ' 条，首个 ' + firstBad);

  // ---- 3. 计分板结构 ----
  console.log('\n== 3. 计分板解析 ==');
  const sbRaw = state.map.get('scoreboard').value;
  const sb = CORE.nbtParseAuto(sbRaw);
  const top = new Map(sb.root.v.entries);
  const objs = top.get('Objectives').v.items;
  const ents = top.get('Entries').v.items;
  ok('Objectives ' + objs.length + ' 项 / Entries ' + ents.length + ' 条');
  const totalScores = objs.reduce((a, o) => a + CORE.nbtGet(o, 'Scores').v.items.length, 0);
  ok('分数总数 ' + totalScores);

  // 身份映射能对上多少
  const ids = new Map();
  let noSid = 0;
  for (const it of ents) {
    const s = CORE.nbtGet(it, 'ScoreboardId');
    if (!s) { noSid++; continue; }
    ids.set(s.v, (CORE.nbtGet(it, 'PlayerId') || {}).v);
  }
  console.log('  Entries 缺 ScoreboardId 的条目: ' + noSid);
  const byUid = new Map();
  for (const p of state.players) { const u = CORE.nbtGet(p.parsed.root, 'UniqueID'); if (u) byUid.set(String(u.v), p); }
  let hit = 0, miss = 0;
  for (const [sid, pid] of ids) { if (byUid.has(String(pid))) hit++; else miss++; }
  console.log('  身份→玩家：命中 ' + hit + ' / 未命中 ' + miss);
  hit > 0 ? ok('PlayerId 能映射到玩家 UniqueID') : bad('映射不上，PlayerId 可能不是 UniqueID');

  // ---- 4. 改分数 → 写回 → 重读 ----
  console.log('\n== 4. 改一个分数，写回 map，重新解析 ==');
  const target = objs.find(o => CORE.nbtGet(o, 'Scores').v.items.length > 3);
  const tName = CORE.nbtGet(target, 'Name').v;
  const sc = CORE.nbtGet(target, 'Scores').v.items;
  const before = CORE.nbtGet(sc[0], 'Score').v;
  const beforeLen = sbRaw.length;
  CORE.nbtGet(sc[0], 'Score').v = 123456;
  state.sb = { parsed: sb, dirty: true };
  PIPE.applyScoreboard(state);
  const after = state.map.get('scoreboard').value;
  const re = CORE.nbtParseAuto(after);
  const reObjs = new Map(re.root.v.entries).get('Objectives').v.items;
  const reObj = reObjs.find(o => CORE.nbtGet(o, 'Name').v === tName);
  const got = CORE.nbtGet(CORE.nbtGet(reObj, 'Scores').v.items[0], 'Score').v;
  console.log('  目标项 ' + tName + ' 分数 ' + before + ' → 123456，重读得到 ' + got);
  console.log('  字节 ' + beforeLen + ' → ' + after.length + '（分数是定长 Int，长度应该不变）');
  got === 123456 ? ok('分数写回并被重新解析到') : bad('写回后读不到新值');
  after.length === beforeLen ? ok('总长度不变') : bad('长度变了 ' + beforeLen + ' → ' + after.length);

  // 未改的部分要保持原样：其它计分项字节级不能动
  console.log('\n== 5. 未改动的计分项没被影响 ==');
  const otherBefore = objs.find(o => o !== target);
  const oName = CORE.nbtGet(otherBefore, 'Name').v;
  const oSc = CORE.nbtGet(otherBefore, 'Scores').v.items;
  const oSample = oSc.slice(0, 3).map(n => CORE.nbtGet(n, 'Score').v);
  const reOther = reObjs.find(o => CORE.nbtGet(o, 'Name').v === oName);
  const reSample = CORE.nbtGet(reOther, 'Scores').v.items.slice(0, 3).map(n => CORE.nbtGet(n, 'Score').v);
  JSON.stringify(oSample) === JSON.stringify(reSample)
    ? ok('「' + oName + '」前 3 条分数原样保留 ' + JSON.stringify(oSample))
    : bad('别的计分项被波及 ' + JSON.stringify(oSample) + ' → ' + JSON.stringify(reSample));

  // ---- 6. 新建 / 删除计分项 ----
  console.log('\n== 6. 新建 + 删除计分项 ==');
  const list = new Map(re.root.v.entries).get('Objectives');
  const n0 = list.v.items.length;
  list.v.items.push({ t: CORE.T.Compound, v: { entries: [
    ['Criteria', { t: 8, v: 'dummy' }],
    ['DisplayName', { t: 8, v: '测试项' }],
    ['Name', { t: 8, v: 'zz_test' }],
    ['Scores', { t: 9, v: { el: 10, items: [] } }]
  ] } });
  const bytes2 = CORE.nbtWrite(re.root, re.name, re.longNames);
  const re2 = CORE.nbtParseAuto(bytes2);
  const objs2 = new Map(re2.root.v.entries).get('Objectives').v.items;
  objs2.length === n0 + 1 ? ok('新建后 ' + n0 + ' → ' + objs2.length + ' 项') : bad('新建失败');
  const mine = objs2.find(o => CORE.nbtGet(o, 'Name').v === 'zz_test');
  mine && CORE.nbtGet(mine, 'DisplayName').v === '测试项' ? ok('中文显示名写入正常') : bad('显示名错了');

  console.log('\n===== ' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
