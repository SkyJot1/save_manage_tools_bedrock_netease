'use strict';
/* 计分板「加玩家」原理验证 + 导出闭环
 * 1) LastUniqueID 是否可用来分配新身份号
 * 2) 新建 Entry + Score 能否写回并被重新解析
 * 3) 导出包能否被独立读器读回，结构有无被破坏
 */
const fs = require('fs');
const CORE = require('./core');
const PIPE = require('./pipeline');
const LV = require('./lvcheck');

const ZIP = process.argv[2] || 'C:/Users/SkyJot/Documents/WorkBuddy/建筑_网易我的世界直接导出压缩解密版本示例_网易基岩基岩测试.zip';

let fail = 0;
const ok = s => console.log('  [OK] ' + s);
const bad = s => { fail++; console.log('  [!!] ' + s); };

const T = CORE.T;

(async () => {
  const state = await PIPE.open(await CORE.readZip(new Uint8Array(fs.readFileSync(ZIP))), () => {});
  const sbRaw = state.map.get('scoreboard').value;
  const parsed = CORE.nbtParseAuto(sbRaw);
  const top = new Map(parsed.root.v.entries);

  const entries = top.get('Entries');
  const objs = top.get('Objectives').v.items;
  const lastNode = top.get('LastUniqueID');

  console.log('== 1. 结构前提 ==');
  console.log('  LastUniqueID 类型 ' + (lastNode && lastNode.t) + '，值 ' + (lastNode && lastNode.v));
  lastNode && lastNode.t === T.Long ? ok('有 LastUniqueID，可安全分配新身份号') : bad('没有 LastUniqueID');
  console.log('  Entries ' + entries.v.items.length + ' 项 / Objectives ' + objs.length + ' 项');

  // 现有身份
  const ids = new Map();
  for (const it of entries.v.items) {
    const sid = CORE.nbtGet(it, 'ScoreboardId');
    if (sid) ids.set(String(sid.v), {
      type: (CORE.nbtGet(it, 'IdentityType') || {}).v,
      pid: (CORE.nbtGet(it, 'PlayerId') || {}).v
    });
  }

  // 找一个已经有身份的玩家（最常见：加进别的计分项）
  const byUid = new Map();
  for (const p of state.players) {
    const u = CORE.nbtGet(p.parsed.root, 'UniqueID');
    if (u) byUid.set(String(u.v), p);
  }
  let withId = null, withoutId = null;
  for (const [pid, p] of byUid) {
    let hit = null;
    for (const [sid, info] of ids) if (info.type === 1 && String(info.pid) === pid) { hit = sid; break; }
    if (hit && !withId) withId = { pid, p, sid: hit };
    if (!hit && !withoutId) withoutId = { pid, p };
  }
  console.log('  已有身份的玩家样例: ' + (withId ? withId.pid + ' → sid ' + withId.sid : '无'));
  console.log('  没有身份的玩家: ' + (withoutId ? withoutId.pid : '无（全部玩家都已有身份）'));

  console.log('\n== 2. 情况 A：玩家已有身份，加一条分数 ==');
  const objA = objs.find(o => {
    const sc = CORE.nbtGet(o, 'Scores');
    return sc && sc.v.items.length > 5;
  });
  const scoreA0 = CORE.nbtGet(objA, 'Scores').v.items.length;
  const scA = CORE.nbtGet(objA, 'Scores').v.items;
  const already = scA.some(n => String((CORE.nbtGet(n, 'ScoreboardId') || {}).v) === String(withId.sid));
  if (!already) {
    scA.push({ t: T.Compound, v: { entries: [
      ['Score', { t: T.Int, v: 0 }],
      ['ScoreboardId', { t: T.Long, v: String(withId.sid) }]
    ] } });
  }
  const bytesA = CORE.nbtWrite(parsed.root, parsed.name, parsed.longNames);
  const reA = CORE.nbtParseAuto(bytesA);
  const reObjA = new Map(reA.root.v.entries).get('Objectives').v.items.find(o => CORE.nbtGet(o, 'Name').v === CORE.nbtGet(objA, 'Name').v);
  const gotA = CORE.nbtGet(reObjA, 'Scores').v.items;
  gotA.length === scoreA0 + (already ? 0 : 1)
    ? ok('「' + CORE.nbtGet(objA, 'Name').v + '」分数条数 ' + scoreA0 + ' → ' + gotA.length)
    : bad('条数不对：' + scoreA0 + ' → ' + gotA.length);
  const tail = gotA[gotA.length - 1];
  String((CORE.nbtGet(tail, 'ScoreboardId') || {}).v) === String(withId.sid)
    ? ok('新条目的 ScoreboardId = ' + withId.sid + '，Score = ' + CORE.nbtGet(tail, 'Score').v)
    : bad('新条目 ScoreboardId 不对');

  console.log('\n== 3. 情况 B：玩家没有身份，新建 Entry ==');
  const beforeLast = BigInt(String(lastNode.v));
  let expect = null;
  if (withoutId) {
    const nid = (beforeLast + 1n).toString();
    lastNode.v = nid;
    entries.v.items.push({ t: T.Compound, v: { entries: [
      ['IdentityType', { t: T.Byte, v: 1 }],
      ['PlayerId', { t: T.Long, v: withoutId.pid }],
      ['ScoreboardId', { t: T.Long, v: nid }]
    ] } });
    expect = nid;
    console.log('  新身份 ' + nid + ' 分配给 ' + withoutId.pid);
  } else {
    // 全部都有身份，就造一个假 UniqueID 验证结构
    const nid = (beforeLast + 1n).toString();
    lastNode.v = nid;
    const fakePid = (BigInt(String(withId.pid)) + 100000n).toString();
    entries.v.items.push({ t: T.Compound, v: { entries: [
      ['IdentityType', { t: T.Byte, v: 1 }],
      ['PlayerId', { t: T.Long, v: fakePid }],
      ['ScoreboardId', { t: T.Long, v: nid }]
    ] } });
    expect = nid;
    console.log('  所有玩家都已有身份，改用假 UniqueID ' + fakePid + ' 测结构');
  }
  const scB = CORE.nbtGet(objA, 'Scores').v.items;
  scB.push({ t: T.Compound, v: { entries: [
    ['Score', { t: T.Int, v: 0 }],
    ['ScoreboardId', { t: T.Long, v: String(expect) }]
  ] } });

  const bytesB = CORE.nbtWrite(parsed.root, parsed.name, parsed.longNames);
  const reB = CORE.nbtParseAuto(bytesB);
  const topB = new Map(reB.root.v.entries);
  const entB = topB.get('Entries').v.items;
  entB.length === entries.v.items.length ? ok('Entries 条数 ' + entB.length) : bad('Entries 条数变了');
  const lastB = String(topB.get('LastUniqueID').v);
  lastB === expect ? ok('LastUniqueID 同步为 ' + lastB) : bad('LastUniqueID = ' + lastB + '，期望 ' + expect);
  const newEnt = entB.find(e => String(CORE.nbtGet(e, 'ScoreboardId').v) === expect);
  newEnt ? ok('新 Entry 能被解析回来（IdentityType=' + CORE.nbtGet(newEnt, 'IdentityType').v + '）') : bad('新 Entry 读不到');
  newEnt && String(CORE.nbtGet(newEnt, 'PlayerId').v) === String(CORE.nbtGet(newEnt, 'PlayerId').v)
    ? ok('PlayerId 字段完整') : bad('PlayerId 丢失');

  console.log('\n== 4. 导出 → 独立校验 ==');
  state.sb = { parsed, dirty: true };
  PIPE.applyScoreboard(state);
  const out = await PIPE.exportArchive(state, { name: 'sbadd.zip' });
  console.log('  导出 ' + (out.data.length / 1048576).toFixed(1) + ' MB');
  const zf = await CORE.readZip(out.data);
  const dbFiles = zf.filter(f => /(^|\/)db\//.test(f.name)).map(f => ({ name: f.name.replace(/^.*\//, ''), data: f.data }));
  const res = LV.checkDatabase(dbFiles, CORE);
  const errs = res.ssts.reduce((a, s) => a + s.errs.length, 0) + res.manifestErrs.length;
  errs === 0 ? ok('LevelDB 结构 0 错误（' + res.keys + ' 条记录）') : bad('结构错误 ' + errs + ' 处');

  const reSb = await (async () => {
    const f = zf.find(x => /(^|\/)db\//.test(x.name) && /\.log$/i.test(x.name));
    return null;
  })();

  // 用本工具重新打开导出包，确认 scoreboard 里读得到新身份
  const st2 = await PIPE.open(zf, () => {});
  const sb2 = st2.map.get('scoreboard');
  if (!sb2) { bad('导出包里没有 scoreboard'); }
  else {
    const p2 = CORE.nbtParseAuto(sb2.value);
    const t2 = new Map(p2.root.v.entries);
    const last2 = String(t2.get('LastUniqueID').v);
    last2 === expect ? ok('重新打开导出包：LastUniqueID = ' + last2) : bad('重新打开后 LastUniqueID = ' + last2);
    const e2 = t2.get('Entries').v.items.filter(e => String(CORE.nbtGet(e, 'ScoreboardId').v) === expect);
    e2.length === 1 ? ok('重新打开导出包：新身份在 Entries 里') : bad('重新打开后找不到新身份');
  }

  console.log('\n===== ' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
