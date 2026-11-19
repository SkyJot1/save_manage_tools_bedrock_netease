/* 业务管线：开包 → 解析 → 导出。浏览器和 node 共用。 */
(function (root, factory) {
  const CORE = (typeof module === 'object' && module.exports) ? require('./core.js') : root.CORE;
  const api = factory(CORE);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PIPE = api;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
  'use strict';

  const T = CORE.T;

  function baseName(n) { const i = n.lastIndexOf('/'); return i < 0 ? n : n.slice(i + 1); }
  function dirName(n) { const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i + 1); }

  /** 从一堆文件里认出世界目录结构（文件夹上传 / zip / mcworld 都走这里） */
  function detectLayout(files) {
    if (!files || !files.length) throw new Error('没有读到任何文件');

    // 1) 优先找 CURRENT：它在哪个目录，db 目录就是哪个
    let dbDir = null;
    const cur = files.find(f => baseName(f.name) === 'CURRENT');
    if (cur) dbDir = dirName(cur.name);

    // 2) 没有 CURRENT 就找任意 .ldb / MANIFEST
    if (dbDir === null) {
      const ldb = files.find(f => /\.(ldb|log)$/i.test(f.name) && !/\/lost\//i.test(f.name));
      if (ldb) dbDir = dirName(ldb.name);
    }
    const man = files.find(f => /^MANIFEST/.test(baseName(f.name)));
    if (dbDir === null && man) dbDir = dirName(man.name);

    if (dbDir === null) {
      const sample = files.slice(0, 8).map(f => f.name).join(' / ');
      throw new Error('没找到 db 目录。这个文件夹里应该是「世界目录」（里面有 db 文件夹），' +
        '不是压缩包也不是别的目录。当前看到：' + sample);
    }
    if (!dbDir.endsWith('/')) dbDir += '/';

    const prefix = dbDir.endsWith('db/') ? dbDir.slice(0, -3) : dbDir;
    const dbFiles = [], worldFiles = [];
    for (const f of files) {
      if (f.name.startsWith(dbDir)) {
        const nm = f.name.slice(dbDir.length);
        if (nm && nm.indexOf('/') < 0) dbFiles.push({ name: nm, data: f.data });
      } else {
        // 目录条目本身（以 / 结尾、没有内容）不用留
        if (/\/$/.test(f.name)) continue;
        // 我们自己工具留下的备份/临时目录，别重新打进导出包
        if (/_clean_work|db_backup_before_clean|db_before_clean_/.test(f.name)) continue;
        if (/\.bak$/i.test(f.name) || /(^|\/)~\$/.test(f.name)) continue;
        worldFiles.push(f);
      }
    }
    if (!dbFiles.length) throw new Error('在 ' + dbDir + ' 里没找到数据库文件');
    return { prefix, dbDir, dbFiles, worldFiles };
  }

  function detectFormat(dbFiles) {
    const cur = dbFiles.find(f => f.name === 'CURRENT');
    if (!cur) return 'unknown';
    return /^MANIFEST-\d+\s*$/.test(CORE.latin1(cur.data)) ? 'standard' : 'netease';
  }

  /** 分类一个 key */
  function classify(key) {
    if (/^player_uid_\d+$/.test(key)) return 'player';
    if (key === '~local_player') return 'player-local';
    if (/^player_[0-9a-fA-F-]{36}$/.test(key)) return 'identity';
    if (key === 'scoreboard') return 'scoreboard';
    if (key === 'LevelChunkMetaDataDictionary' || key === 'BiomeData' || key === 'AutonomousEntities' ||
      key === 'mobevents' || key === 'neteaseData' || /^SST_/.test(key) || /^PosTrackDB/.test(key) ||
      key === 'Overworld' || key === 'Nether' || key === 'TheEnd') return 'world';
    if (/^map_/.test(key)) return 'map';
    if (/^editor:/.test(key)) return 'editor';
    return 'chunk';
  }

  function isNbtValue(u8) {
    return u8 && u8.length > 3 && u8[0] === 0x0a;
  }

  /** 打开：files 是 [{name, data}]（已解压） */
  async function open(files, onProgress) {
    const say = (s, p) => onProgress && onProgress(s, p);
    say('识别目录结构…', 0.02);
    const layout = detectLayout(files);
    const format = detectFormat(layout.dbFiles);
    say('读取 LevelDB（' + layout.dbFiles.length + ' 个文件）…', 0.06);
    // 网易版的 .ldb / MANIFEST / CURRENT 是加密的，先在内存里解出来
    const plain = layout.dbFiles.map(f => ({ name: f.name, data: CORE.decryptFile(f.name, f.data) }));
    const warnings = [];
    const map = await CORE.readDatabase(plain, (d, t) => say('读取 ' + d + '/' + t, 0.06 + 0.55 * d / t),
      (name, why) => { warnings.push({ name, why }); say('跳过 ' + name + '：' + why, null); });

    say('分类键值…', 0.62);
    const stats = { total: map.size, nbt: 0, chunk: 0, player: 0, identity: 0, other: 0, byCat: {} };
    const keys = [];
    for (const [k, v] of map) {
      const cat = classify(k);
      stats.byCat[cat] = (stats.byCat[cat] || 0) + 1;
      if (isNbtValue(v.value)) stats.nbt++;
      if (cat === 'player' || cat === 'player-local') stats.player++;
      else if (cat === 'chunk') stats.chunk++;
      else if (cat === 'identity') stats.identity++;
      else stats.other++;
      keys.push(k);
    }

    say('解析玩家 NBT…', 0.66);
    const players = [];
    let i = 0;
    for (const [k, v] of map) {
      const cat = classify(k);
      if (cat !== 'player' && cat !== 'player-local') continue;
      i++;
      if (i % 400 === 0) say('解析玩家 NBT ' + i + '…', 0.66 + 0.3 * i / Math.max(1, stats.player));
      let parsed = null;
      try { parsed = CORE.nbtParseAuto(v.value); } catch (e) { parsed = null; }
      if (!parsed) continue;
      players.push({ key: k, raw: v.value, parsed });
    }
    players.sort((a, b) => {
      const la = CORE.nbtNum(CORE.nbtGet(a.parsed.root, 'PlayerLevel')) || 0;
      const lb = CORE.nbtNum(CORE.nbtGet(b.parsed.root, 'PlayerLevel')) || 0;
      return lb - la;
    });
    say('完成', 1);
    const state = { layout, format, map, stats, keys, players, warnings, levelDat: null };
    try { state.levelDat = readLevelDat(state); } catch (e) { state.levelDat = null; }
    return state;
  }

  // ---------------------------------------------------------------- 玩家字段映射
  const ATTRS = {
    health: 'minecraft:health',
    hunger: 'minecraft:player.hunger',
    saturation: 'minecraft:player.saturation',
    exhaustion: 'minecraft:player.exhaustion',
    experience: 'minecraft:player.experience',
    level: 'minecraft:player.level'
  };

  function attrNode(root, name) {
    const list = CORE.nbtGet(root, 'Attributes');
    if (!list || list.t !== T.List) return null;
    for (const it of list.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === name) return it;
    }
    return null;
  }

  function readPlayer(pl) {
    const r = pl.parsed.root;
    const pos = CORE.nbtGet(r, 'Pos');
    const rot = CORE.nbtGet(r, 'Rotation');
    const dim = CORE.nbtGet(r, 'DimensionId');
    const gm = CORE.nbtGet(r, 'PlayerGameMode');
    const lv = CORE.nbtGet(r, 'PlayerLevel');
    const prog = CORE.nbtGet(r, 'PlayerLevelProgress');
    const air = CORE.nbtGet(r, 'Air');
    const tags = CORE.nbtGet(r, 'Tags');
    const inv = CORE.nbtGet(r, 'Inventory');
    const uid = /^player_uid_(\d+)$/.exec(pl.key);
    const hp = attrNode(r, ATTRS.health);
    const food = attrNode(r, ATTRS.hunger);
    const sat = attrNode(r, ATTRS.saturation);
    const exh = attrNode(r, ATTRS.exhaustion);
    const fb = playerFastbuild(pl);
    return {
      key: pl.key,
      uid: uid ? uid[1] : (pl.key === '~local_player' ? '主机' : ''),
      nick: fb && fb.name ? fb.name : '',
      level: lv ? lv.v : 0,
      progress: prog ? prog.v : 0,
      health: hp ? CORE.nbtGet(hp, 'Current').v : null,
      healthMax: hp ? CORE.nbtGet(hp, 'Max').v : null,
      hunger: food ? CORE.nbtGet(food, 'Current').v : null,
      saturation: sat ? CORE.nbtGet(sat, 'Current').v : null,
      exhaustion: exh ? CORE.nbtGet(exh, 'Current').v : null,
      air: air ? air.v : null,
      x: pos ? pos.v.items[0].v : null,
      y: pos ? pos.v.items[1].v : null,
      z: pos ? pos.v.items[2].v : null,
      yaw: rot ? rot.v.items[0].v : null,
      pitch: rot ? rot.v.items[1].v : null,
      dim: dim ? dim.v : null,
      gamemode: gm ? gm.v : null,
      tags: tags ? tags.v.items.map(x => x.v) : [],
      invCount: inv ? inv.v.items.length : 0,
      perm: (CORE.nbtGet(r, 'permissionsLevel') || {}).v,
      fb
    };
  }

  function playerFastbuild(pl) {
    const sd = CORE.nbtGet(pl.parsed.root, 'scriptData');
    if (!sd || !sd.b) return null;
    try {
      const fb = CORE.parseFastbuilder(sd.b);
      if (!fb) return null;
      const name = CORE.fbGet(fb, 'name');
      const level = CORE.fbGet(fb, 'level');
      const cl = CORE.fbGet(fb, 'cross_load');
      const cs = CORE.fbGet(fb, 'cross_save');
      return {
        raw: fb, bytes: sd.b,
        name: name && name.t === 'str' ? name.v : '',
        level: level && level.t === 'num' ? level.v : 0,
        cross_load: !!(cl && cl.t === 'bool' && cl.v),
        cross_save: !!(cs && cs.t === 'bool' && cs.v)
      };
    } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- 物品名 */
  let ITEMS = {};
  try {
    if (typeof module === 'object' && module.exports) ITEMS = require('./items.js');
    else if (typeof window !== 'undefined' && window.ITEMS) ITEMS = window.ITEMS;
  } catch (e) { ITEMS = {}; }

  function itemName(id) {
    const k = String(id || '').replace(/^minecraft:/i, '').toLowerCase();
    if (!k) return '';
    return ITEMS[k] || ITEMS[k.replace(/_/g, '')] || k;
  }
  /* 中文名 + 损伤值（羊毛、染料这类靠 Damage 区分的直接显示数字） */
  function itemLabel(id, damage) {
    if (!id) return '';
    const n = itemName(id);
    return damage > 0 ? n + ' ·' + damage : n;
  }

  /* 改字符串必须把 node.b 清掉：解析时缓存了原始字节，不清就会被原样写回 */
  function setStr(node, v) {
    if (!node) return;
    node.v = v;
    node.b = null;
  }

  /* ---------------------------------------------------------------- 背包 */
  const CONTAINERS = {
    inv: 'Inventory', armor: 'Armor', offhand: 'Offhand',
    mainhand: 'Mainhand', ender: 'EnderChestInventory', effects: 'ActiveEffects'
  };

  function readItem(node) {
    const name = CORE.nbtGet(node, 'Name');
    const count = CORE.nbtGet(node, 'Count');
    const dmg = CORE.nbtGet(node, 'Damage');
    const id = name ? name.v : '';
    return {
      node, id,
      name: itemName(id),
      label: itemLabel(id, dmg ? dmg.v : 0),
      count: count ? count.v : 0,
      damage: dmg ? dmg.v : 0,
      empty: !id || !(count && count.v > 0)
    };
  }

  function readInventory(pl) {
    const r = pl.parsed.root;
    const out = {};
    for (const [k, name] of Object.entries(CONTAINERS)) {
      const list = CORE.nbtGet(r, name);
      out[k] = (list && list.t === T.List) ? list.v.items.map(readItem) : null;
    }
    return out;
  }

  /* 改一个格子；id 为空就把这格清空 */
  function setItem(item, id, count, damage) {
    const n = item.node;
    const nameN = CORE.nbtGet(n, 'Name');
    const cntN = CORE.nbtGet(n, 'Count');
    const dmgN = CORE.nbtGet(n, 'Damage');
    const clean = !id || count <= 0;
    if (nameN) { nameN.v = clean ? '' : id; nameN.b = null; }
    else if (!clean) n.v.entries.push(['Name', { t: T.String, v: id }]);
    if (cntN) cntN.v = clean ? 0 : (count | 0);
    else if (!clean) n.v.entries.push(['Count', { t: T.Byte, v: count | 0 }]);
    if (dmgN) dmgN.v = clean ? 0 : (damage | 0);
    else if (!clean) n.v.entries.push(['Damage', { t: T.Short, v: damage | 0 }]);
    return readItem(n);
  }

  /* ---------------------------------------------------------------- 模组 */
  /* scriptData 里所有「标识 + 映射」块。7stars 只是其中一种，
   * 以后有别的模组要适配，只要它也是这个形状，这里自动就能认出来。 */
  function readMods(pl) {
    const sd = CORE.nbtGet(pl.parsed.root, 'scriptData');
    if (!sd || !sd.b) return [];
    let list = [];
    try { list = CORE.scanMods(sd.b); } catch (e) { return []; }
    for (const m of list) {
      m.fields = m.node.pairs.map(([k, v]) => ({ key: k.v, node: v }));
    }
    return list;
  }

  /* 按 start 从大到小写，前面的偏移才不会被打乱 */
  function writeMods(pl, mods) {
    const sd = CORE.nbtGet(pl.parsed.root, 'scriptData');
    if (!sd || !sd.b) return false;
    const order = (mods || []).slice().sort((a, b) => b.start - a.start);
    for (const m of order) {
      if (!m.safe) continue;
      sd.b = CORE.replaceMod(sd.b, m);
    }
    sd.v = CORE.latin1(sd.b);
    return true;
  }

  /* ---------------------------------------------------------------- level.dat */
  function findLevelDat(state) {
    return state.layout.worldFiles.find(f => /(^|\/)level\.dat$/i.test(f.name)) || null;
  }

  function readLevelDat(state) {
    const f = findLevelDat(state);
    if (!f || f.data.length < 10) return null;
    const u8 = f.data;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = dv.getInt32(0, true);
    const length = dv.getInt32(4, true);
    let parsed;
    try { parsed = CORE.nbtParseAuto(u8.subarray(8)); } catch (e) { return null; }
    return { file: f, version, length, parsed, dirty: false };
  }

  function writeLevelDat(state) {
    const ld = state.levelDat;
    if (!ld || !ld.dirty) return;
    const body = CORE.nbtWrite(ld.parsed.root, ld.parsed.name, ld.parsed.longNames);
    const out = new Uint8Array(8 + body.length);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, ld.version || 10, true);
    dv.setInt32(4, body.length, true);
    out.set(body, 8);
    ld.file.data = out;
    ld.length = body.length;
  }

  /** 把修改写回：只重写玩家记录 */
  function applyPlayers(state, players) {
    for (const p of players) {
      if (!p.dirty) continue;
      const bytes = CORE.nbtWrite(p.parsed.root, p.parsed.name, p.parsed.longNames);
      const e = state.map.get(p.key);
      if (e) e.value = bytes;
    }
  }

  /** 计分板改过就重新序列化写回 map（节点树由界面层挂在 state.sb 上） */
  function applyScoreboard(state) {
    const sb = state.sb;
    if (!sb || !sb.dirty) return;
    const bytes = CORE.nbtWrite(sb.parsed.root, sb.parsed.name, sb.parsed.longNames);
    const e = state.map.get('scoreboard');
    if (e) e.value = bytes;
    sb.dirty = false;
  }

  /** 导出：重建 db，并打包成 zip */
  async function exportArchive(state, opts) {
    opts = opts || {};
    applyPlayers(state, state.players);
    applyScoreboard(state);
    writeLevelDat(state);
    const entries = [];
    for (const [k, v] of state.map) entries.push({ key: v.key || CORE.asciiBytes(k), value: v.value });
    const dbFiles = await CORE.buildDatabase(entries, { compress: true });

    // 导出自检：按 leveldb 的读取路径验一遍块尾 CRC 和 restart 数组。
    // 不通过就不出文件 —— 宁可报错，也不要给用户一个「进游戏全空」的世界。
    let report = null;
    if (opts.verify !== false && typeof CORE.verifyDatabase === 'function') {
      if (opts.onProgress) opts.onProgress('校验导出的数据库…', 0.88);
      report = await CORE.verifyDatabase(dbFiles, (d, t) => {
        if (opts.onProgress) opts.onProgress('校验 ' + d + '/' + t + ' 个文件', 0.88 + 0.12 * d / Math.max(1, t));
      });
      report.entries = entries.length;   // 快速模式下不解压数据块，键数按写入条数计
      state.lastVerify = report;
      if (!report.ok) {
        const err = new Error('导出自检没通过（发现 ' + report.problems.length + ' 处问题），已中止，没有生成文件。');
        err.problems = report.problems;
        err.report = report;
        throw err;
      }
    }

    const seal = state.format === 'netease';
    const out = [];
    for (const f of state.layout.worldFiles) out.push(f);
    for (const f of dbFiles) {
      out.push({ name: state.layout.dbDir + f.name, data: seal ? CORE.encryptFile(f.name, f.data) : f.data });
    }
    return { name: opts.name || 'world_edited.zip', data: CORE.writeZip(out) };
  }

  /** 只导出玩家 NBT 的 JSON 摘要 */
  function playersToJson(state) {
    return JSON.stringify(state.players.map(p => {
      const d = readPlayer(p);
      return {
        key: d.key, uid: d.uid, nick: d.nick, level: d.level, progress: d.progress,
        health: d.health, hunger: d.hunger, saturation: d.saturation, air: d.air,
        x: d.x, y: d.y, z: d.z, dim: d.dim, gamemode: d.gamemode, tags: d.tags,
        invCount: d.invCount, perm: d.perm,
        fastbuild: d.fb ? { level: d.fb.level, cross_load: d.fb.cross_load, cross_save: d.fb.cross_save } : null
      };
    }), null, 1);
  }

  return {
    detectLayout, detectFormat, classify, isNbtValue, open, readPlayer, exportArchive,
    playersToJson, playerFastbuild, applyScoreboard,
    itemName, itemLabel, readInventory, setItem, setStr,
    readMods, writeMods, readLevelDat, writeLevelDat, findLevelDat
  };
});
