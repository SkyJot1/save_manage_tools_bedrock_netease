/* UI 层 */
(function () {
  'use strict';
  const CORE = window.CORE, PIPE = window.PIPE;
  const T = CORE.T;
  const $ = id => document.getElementById(id);
  const el = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt != null) d.textContent = txt; return d; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, n) => (v == null || v === '') ? '' : (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(n == null ? 2 : n)) : v);

  /* 十六进制片段，给二进制字段用 */
  const hexSnippet = (b, n) => {
    let s = '';
    for (let i = 0; i < b.length && i < n; i++) s += (i ? ' ' : '') + b[i].toString(16).padStart(2, '0');
    return s + (b.length > n ? ' …' : '');
  };

  /* 区块 key 是裸二进制（x/z/维度/tag 四个小端整数），直接塞进 DOM 就是一排方块。
   * 认不出来的一律转义成 \xNN，宁可难看也不要乱码。 */
  function keyLabel(k) {
    let odd = false;
    for (let i = 0; i < k.length; i++) {
      const c = k.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) { odd = true; break; }
    }
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

  let state = null;      // {layout, format, map, stats, keys, players}
  let curPlayer = null;  // 选中的 player 对象
  let curKey = null;     // 全部数据里选中的 key
  let editing = false;

  // 自动化自测用：把当前打开的状态暴露出去（只读，不影响界面行为）
  window.__wbState = () => state;

  function log(msg, pct) {
    const box = $('log');
    if (!box) return;
    const line = el('div', 'logline', msg);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    if (pct != null) setProgress(pct);
    while (box.childNodes.length > 300) box.removeChild(box.firstChild);
  }
  function setProgress(p) {
    if (p == null) return;
    const bar = $('bar');
    if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  }

  // ---------------------------------------------------------------- 打开
  async function openFiles(files) {
    // 必须在第一个 await 之前把 FileList 拷成数组：
    // 输入框一旦被清空，FileList 会立刻变空，后面就只剩第一个文件了。
    const arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    $('welcome').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('log').innerHTML = '';
    setProgress(0);
    try {
      const list = [];
      for (let i = 0; i < arr.length; i++) {
        const f = arr[i];
        if (arr.length > 30 && i % 10 === 0) log('读取文件 ' + (i + 1) + ' / ' + arr.length + '：' + (f.webkitRelativePath || f.name), 0.01 + 0.05 * i / arr.length);
        list.push({ name: f.webkitRelativePath || f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
      log('共 ' + list.length + ' 个文件');
      let packed = list;

      // 单个压缩包：直接解
      if (list.length === 1 && /\.(zip|mcworld|mctemplate)$/i.test(list[0].name)) {
        log('解压 ' + list[0].name + ' …', 0.02);
        packed = await CORE.readZip(list[0].data);
        log('解压完成，' + packed.length + ' 个文件', 0.05);
      } else {
        // 选的是一个「装着压缩包」的文件夹：里面没有 db，但有唯一一个包，就自动拆它
        const hasDb = list.some(f => /(^|\/)CURRENT$/.test(f.name) || /\.ldb$/i.test(f.name));
        if (!hasDb) {
          const zips = list.filter(f => /\.(zip|mcworld|mctemplate)$/i.test(f.name));
          if (zips.length === 1) {
            log('文件夹里没有 db，改用压缩包 ' + zips[0].name, 0.02);
            packed = await CORE.readZip(zips[0].data);
            log('解压完成，' + packed.length + ' 个文件', 0.05);
          }
        }
      }
      state = await PIPE.open(packed, (s, p) => log(s, p));
      $('fmtTag').textContent = state.format === 'netease' ? '网易加密 · 已解密' : '标准 LevelDB';
      state.players.forEach((p, i) => { p._i = i; });
      state.sel = new Set();
      sb = null; sbSel = null; sbPage = 0;
      log('完成：' + state.stats.total + ' 个键，' + state.stats.nbt + ' 个可解析 NBT，' + state.players.length + ' 个玩家', 1);
      renderIdent();
      renderStats();
      renderPlayers();
      renderKeys();
      $('tab-overview').classList.add('on');
      switchTab('overview');
    } catch (e) {
      log('❌ ' + (e && e.message || e));
      console.error(e);
    }
  }

  /* ---------------------------------------------------------------- 版本鉴别
   * 只看 db/CURRENT，别的文件一概不参与判断：
   *   CURRENT 明文就是 "MANIFEST-000123"            → 国际基岩（MCBE）
   *   CURRENT 解密之后才是 "MANIFEST-…"（网易加密）   → 网易基岩（中国版）
   * 不能拿 netease_world_*.json / studio.json / level.dat 的 netease* 字段当判据：
   * 网易存档转成基岩之后这些文件还留在原地，按它们打分就会把转换过的档判成网易。
   */
  function currentOwner() {
    const dbFiles = (state.layout && state.layout.dbFiles) || [];
    const cur = dbFiles.find(f => /(^|\/)CURRENT$/i.test(String(f.name)));
    if (!cur) return 'unknown';
    if (/^MANIFEST-\d+\s*$/.test(CORE.latin1(cur.data))) return 'mcbe';
    const dec = CORE.decryptFile('CURRENT', cur.data);
    if (dec !== cur.data && /^MANIFEST-\d+\s*$/.test(CORE.latin1(dec))) return 'netease';
    return 'unknown';
  }

  function verArr(node) {
    if (!node || node.t !== 9 || !node.v || !node.v.items) return '';
    const a = node.v.items.map(it => (typeof it.v === 'bigint' ? Number(it.v) : it.v));
    while (a.length > 3 && a[a.length - 1] === 0) a.pop();
    return a.every(x => x === 0) ? '' : a.join('.');
  }
  function verStr(node) {
    return node && typeof node.v === 'string' ? node.v : '';
  }

  function renderIdent() {
    const box = $('ident');
    if (!box) return;
    if (!state) { box.className = 'ident'; box.innerHTML = ''; return; }

    const r = state.levelDat && state.levelDat.parsed && state.levelDat.parsed.root;
    const get = k => (r ? CORE.nbtGet(r, k) : undefined);

    const owner = currentOwner();
    const verdict = owner === 'netease' ? '网易基岩（中国版）'
      : owner === 'mcbe' ? '国际基岩（MCBE）' : '无法判定';
    const cls = owner === 'netease' ? 'n' : owner === 'mcbe' ? 'm' : 'u';

    // 版本：优先 lastOpenedWithVersion，退 MinimumCompatibleClientVersion，再退 InventoryVersion
    const vMain = verArr(get('lastOpenedWithVersion'));
    const vCompat = verArr(get('MinimumCompatibleClientVersion'));
    const vInv = verStr(get('InventoryVersion'));
    let ver = vMain || vCompat || vInv, verTip = '';
    if (!vMain && ver) verTip = vCompat ? '（最低兼容）' : '（存档格式）';

    const bits = [];
    const net = get('NetworkVersion'), store = get('StorageVersion');
    if (net && typeof net.v === 'number') bits.push('协议 ' + net.v);
    if (store && typeof store.v === 'number') bits.push('存储 ' + store.v);
    if (vInv && vInv !== ver) bits.push('存档格式 ' + vInv);
    if (vCompat && vCompat !== ver) bits.push('最低兼容 ' + vCompat);
    const lname = verStr(get('LevelName'));
    if (lname) bits.push('世界「' + lname + '」');
    if (owner === 'unknown') bits.unshift('没读到 db/CURRENT');

    box.className = 'ident ' + cls;
    box.innerHTML =
      '<div class="iline">' +
        '<span class="ik">版本鉴别</span>' +
        '<span class="badge">' + esc(verdict) + '</span>' +
        (ver ? '<span class="ver">' + esc(ver) + '</span>' : '') +
        (verTip ? '<span class="sub">' + esc(verTip) + '</span>' : '') +
        '<span class="sub">' + esc(bits.join(' · ')) + '</span>' +
      '</div>';
  }

  function renderStats() {
    const s = state.stats;
    const warn = (state.warnings || []);
    $('warns').innerHTML = warn.length
      ? '<div class="warnbox"><b>有 ' + warn.length + ' 个数据库文件读不了，已跳过</b>' +
        '<div class="hint">多半是游戏正开着在写盘。要完整读取，先完全退出游戏再打开这个存档。</div>' +
        warn.slice(0, 8).map(w => '<div class="mono">' + esc(w.name) + ' — ' + esc(w.why) + '</div>').join('') +
        (warn.length > 8 ? '<div class="mono">…还有 ' + (warn.length - 8) + ' 个</div>' : '') + '</div>'
      : '';
    $('stats').innerHTML = [
      ['格式', state.format === 'netease' ? '网易加密' : '标准 LevelDB'],
      ['键总数', s.total],
      ['可解析 NBT', s.nbt],
      ['玩家记录', s.player],
      ['区块键', s.chunk],
      ['地图', s.byCat.map || 0],
      ['身份映射', s.identity],
      ['world/editor', (s.byCat.world || 0) + (s.byCat.editor || 0)]
    ].map(([k, v]) => '<div class="cell"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>').join('');
    const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
    $('cats').innerHTML = cats.map(([k, v]) => '<span class="chip">' + esc(k) + ' <b>' + v + '</b></span>').join('');

    // 常用 NBT 键，一键跳到「全部数据」
    const quick = ['scoreboard', '~local_player', 'neteaseData', 'mobevents', 'BiomeData',
      'AutonomousEntities', 'LevelChunkMetaDataDictionary', 'Overworld', 'Nether', 'TheEnd'];
    const have = quick.filter(k => state.map.has(k));
    const extra = state.keys.filter(k => /^(SST_|PosTrackDB|editor:)/.test(k)).slice(0, 6);
    $('quick').innerHTML = have.concat(extra).map(k =>
      '<button class="chip qk" data-k="' + encodeURIComponent(k) + '">' + esc(k) + '</button>').join('');
    $('quick').querySelectorAll('.qk').forEach(b => b.onclick = () => {
      switchTab('data');
      showKey(decodeURIComponent(b.dataset.k));
    });
  }

  // ---------------------------------------------------------------- 玩家列表
  let playerFilter = '';
  let onlyFb = false;
  const hasFb = d => !!(d && d.fb && (d.fb.level > 0 || d.fb.cross_load || d.fb.cross_save));
  function renderPlayers() {
    const tb = $('plist');
    const q = playerFilter.trim().toLowerCase();
    const rows = [];
    for (let idx = 0; idx < state.players.length; idx++) {
      const p = state.players[idx];
      if (!p._d) { p._d = PIPE.readPlayer(p); p._i = idx; }
      const d = p._d;
      if (q && !(String(d.nick).toLowerCase().includes(q) || String(d.uid).includes(q))) continue;
      if (onlyFb && !hasFb(d)) continue;
      rows.push(p);
      if (rows.length >= 300) break;
    }
    $('pcount').textContent = rows.length + ' / ' + state.players.length;
    tb.innerHTML = rows.map((p, i) => {
      const d = p._d;
      const on = state.sel.has(p._i);
      return '<tr data-i="' + p._i + '"' + (on ? ' class="sel"' : '') + '>' +
        '<td class="ck"><input type="checkbox" data-ck="' + p._i + '"' + (on ? ' checked' : '') + '></td>' +
        '<td>' + esc(d.nick || '—') + '</td>' +
        '<td class="mono">' + esc(d.uid) + '</td>' +
        '<td>' + esc(d.level) + '</td>' +
        '<td>' + esc(fmt(d.health, 1)) + '</td>' +
        '<td>' + esc(fmt(d.x, 1)) + ', ' + esc(fmt(d.y, 1)) + ', ' + esc(fmt(d.z, 1)) + '</td>' +
        '<td>' + esc(d.invCount) + '</td>' +
        '<td>' + (d.fb && (d.fb.level > 0 || d.fb.cross_load) ? '<i class="dot"></i>' : '') + '</td>' +
        '</tr>';
    }).join('');
    tb.querySelectorAll('tr').forEach(tr => tr.onclick = (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      selectPlayer(+tr.dataset.i);
    });
    tb.querySelectorAll('input[data-ck]').forEach(ck => ck.onclick = (e) => {
      e.stopPropagation();
      const i = +ck.dataset.ck;
      if (ck.checked) state.sel.add(i); else state.sel.delete(i);
      ck.closest('tr').classList.toggle('sel', ck.checked);
      updateSelCount();
    });
    updateSelCount();
  }

  function selectPlayer(i) {
    curPlayer = state.players[i];
    curPlayer._d = PIPE.readPlayer(curPlayer);
    $('pempty').classList.add('hidden');
    $('pdetail').classList.remove('hidden');
    $('ptitle').textContent = curPlayer._d.nick || curPlayer._d.uid || curPlayer.key;
    $('psub').textContent = curPlayer.key;
    renderPlayerFields();
    renderNbtTree($('praw'), curPlayer.parsed.root, 'root');
  }

  const GM = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观（旧）', 5: '默认', 6: '旁观' };
  const DIM = { 0: '主世界', 1: '下界', 2: '末地' };

  function numInput(label, val, step, onChange, hint) {
    const wrap = el('div', 'row');
    wrap.innerHTML = '<label>' + esc(label) + (hint ? '<i>' + esc(hint) + '</i>' : '') + '</label>';
    const inp = el('input');
    inp.type = 'number';
    if (step) inp.step = step;
    inp.value = val == null ? '' : (typeof val === 'number' && !Number.isInteger(val) ? +val.toFixed(4) : val);
    inp.onchange = () => { onChange(parseFloat(inp.value)); markDirty(); };
    wrap.appendChild(inp);
    return wrap;
  }

  function renderPlayerFields() {
    const p = curPlayer, d = p._d, r = p.parsed.root;
    const box = $('pfields');
    box.innerHTML = '';
    const sec = (title) => { const h = el('div', 'sect', title); box.appendChild(h); const g = el('div', 'grid'); box.appendChild(g); return g; };

    let g = sec('身份');
    g.appendChild(readonly('UID', d.uid));
    g.appendChild(readonly('记录键', p.key));
    g.appendChild(readonly('快建昵称', d.nick || '（无）'));

    g = sec('位置');
    const pos = CORE.nbtGet(r, 'Pos');
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      g.appendChild(numInput(ax + ' 坐标', pos.v.items[i].v, 0.01, v => { pos.v.items[i].v = v; d[[['x', 'y', 'z'][i]][0]] = v; }));
    });
    g.appendChild(numInput('维度', d.dim, 1, v => {
      const n = CORE.nbtGet(r, 'DimensionId'); n.v = v | 0; d.dim = v | 0;
    }, '0 主世界 / 1 下界 / 2 末地'));
    const rot = CORE.nbtGet(r, 'Rotation');
    if (rot) {
      g.appendChild(numInput('水平朝向', rot.v.items[0].v, 0.1, v => { rot.v.items[0].v = v; }));
      g.appendChild(numInput('俯仰角', rot.v.items[1].v, 0.1, v => { rot.v.items[1].v = v; }));
    }

    g = sec('生存');
    attrField(g, r, 'minecraft:health', '生命值', 1, v => { d.health = v; });
    attrField(g, r, 'minecraft:player.hunger', '饥饿值', 1, v => { d.hunger = v; });
    attrField(g, r, 'minecraft:player.saturation', '饱和值', 0.1, v => { d.saturation = v; });
    attrField(g, r, 'minecraft:player.exhaustion', '消耗度', 0.01, v => { d.exhaustion = v; });
    const air = CORE.nbtGet(r, 'Air');
    if (air) g.appendChild(numInput('氧气值', air.v, 1, v => { air.v = v | 0; }));

    g = sec('经验与模式');
    g.appendChild(numInput('经验等级', CORE.nbtGet(r, 'PlayerLevel').v, 1, v => { CORE.nbtGet(r, 'PlayerLevel').v = v | 0; d.level = v | 0; }));
    g.appendChild(numInput('下一级进度', CORE.nbtGet(r, 'PlayerLevelProgress').v, 0.001, v => { CORE.nbtGet(r, 'PlayerLevelProgress').v = v; }));
    const gmNode = CORE.nbtGet(r, 'PlayerGameMode');
    if (gmNode) {
      const wrap = el('div', 'row');
      wrap.innerHTML = '<label>游戏模式</label>';
      const sel = el('select');
      Object.entries(GM).forEach(([k, v]) => { const o = el('option', null, v); o.value = k; sel.appendChild(o); });
      sel.value = String(gmNode.v);
      sel.onchange = () => { gmNode.v = parseInt(sel.value, 10); markDirty(); };
      wrap.appendChild(sel);
      g.appendChild(wrap);
    }

    g = sec('标签（Tags）');
    const tagsRow = el('div', 'row wide');
    tagsRow.innerHTML = '<label>每行一个</label>';
    const ta = el('textarea');
    ta.rows = 4;
    ta.value = d.tags.join('\n');
    ta.onchange = () => {
      const list = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      setTags(r, list);
      markDirty();
    };
    tagsRow.appendChild(ta);
    g.appendChild(tagsRow);

    g = sec('快建权限');
    const fb = d.fb;
    if (!fb) {
      const n = el('div', 'note', '这条记录里没有 7stars_fastbuilder 数据');
      g.appendChild(n);
    } else {
      g.appendChild(numInput('快建等级', fb.level, 1, v => {
        CORE.fbSet(fb.raw, 'level', { t: 'num', v: v | 0 });
        writeFastbuild(p, fb);
        d.fb.level = v | 0;
      }));
      g.appendChild(boolInput('允许跨世界读取', fb.cross_load, v => {
        CORE.fbSet(fb.raw, 'cross_load', { t: 'bool', v });
        writeFastbuild(p, fb); d.fb.cross_load = v;
      }));
      g.appendChild(boolInput('允许跨世界保存', fb.cross_save, v => {
        CORE.fbSet(fb.raw, 'cross_save', { t: 'bool', v });
        writeFastbuild(p, fb); d.fb.cross_save = v;
      }));
    }
    g.appendChild(numInput('玩家权限等级', d.perm, 1, v => {
      const a = CORE.nbtGet(r, 'permissionsLevel'); if (a) a.v = v | 0;
      const b = CORE.nbtGet(r, 'playerPermissionsLevel'); if (b) b.v = v | 0;
      d.perm = v | 0;
    }, '0 普通 / 1 管理员 / 2 服主'));

    // 背包、模组这些用整宽区域，不塞进两列网格
    const wide = (title) => {
      const box2 = el('div', 'sect', title);
      box.appendChild(box2);
      const holder = el('div', 'row wide');
      box.appendChild(holder);
      return holder;
    };

    const inv = PIPE.readInventory(p);
    const bagBox = wide('背包');
    bagBox.appendChild(buildInv(p, inv));

    const modBox = el('div', 'row wide');
    box.appendChild(el('div', 'sect', '模组数据（scriptData）'));
    box.appendChild(modBox);
    p._modBox = modBox;
    renderModSection(p, modBox);
  }

  function attrField(g, root, attrName, label, step, cb) {
    const list = CORE.nbtGet(root, 'Attributes');
    if (!list) return;
    for (const it of list.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (!n || n.v !== attrName) continue;
      const cur = CORE.nbtGet(it, 'Current');
      g.appendChild(numInput(label, cur.v, step, v => { cur.v = v; cb && cb(v); }));
      return;
    }
  }

  function boolInput(label, val, onChange) {
    const wrap = el('div', 'row');
    wrap.innerHTML = '<label>' + esc(label) + '</label>';
    const sw = el('button', 'switch' + (val ? ' on' : ''), val ? '开' : '关');
    sw.onclick = () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      sw.textContent = next ? '开' : '关';
      onChange(next);
      markDirty();
    };
    wrap.appendChild(sw);
    return wrap;
  }

  function readonly(label, val) {
    const wrap = el('div', 'row');
    wrap.innerHTML = '<label>' + esc(label) + '</label><div class="ro">' + esc(val) + '</div>';
    return wrap;
  }

  function setTags(root, list) {
    const tags = CORE.nbtGet(root, 'Tags');
    if (!tags) return;
    tags.v.items = list.map(s => ({ t: T.String, v: s }));
  }

  function writeFastbuild(p, fb) {
    const sd = CORE.nbtGet(p.parsed.root, 'scriptData');
    if (!sd || !sd.b) return;
    // scriptData 里除了 7stars 可能还有别的数据（马匹数据之类），只替换中间那一段
    const prefix = sd.b.subarray(0, fb.raw.start);
    const suffix = sd.b.subarray(fb.raw.end);
    const mid = CORE.encodeMapPairs(fb.raw.node);
    sd.b = CORE.concat([prefix, mid, suffix]);
    sd.v = CORE.latin1(sd.b);
  }

  function markDirty(p) {
    if (p) p.dirty = true;
    editing = true;
    $('dirtyTip').textContent = '有未导出的修改';
    $('dirtyTip').classList.add('on');
    if (p) { p._d = null; renderPlayers(); }
  }

  // ---------------------------------------------------------------- NBT 树
  function renderNbtTree(box, node, name) {
    box.innerHTML = '';
    if (!node) { box.appendChild(el('div', 'note', '没有这个节点')); return; }
    const rootLine = treeRow(node, name, 0);
    box.appendChild(rootLine);
  }

  function typeBadge(t) {
    const map = { 1: 'B', 2: 'S', 3: 'I', 4: 'L', 5: 'F', 6: 'D', 7: 'BA', 8: 'S', 9: 'L', 10: 'C', 11: 'IA', 12: 'LA' };
    return '<span class="badge t' + t + '">' + (map[t] || '?') + '</span>';
  }

  function treeRow(node, name, depth, editable) {
    const wrap = el('div', 'node');
    const line = el('div', 'nline');
    line.style.paddingLeft = (depth * 14) + 'px';
    const isBranch = node.t === T.Compound || node.t === T.List;
    if (isBranch) {
      const arrow = el('span', 'arrow', '▸');
      line.appendChild(arrow);
      line.insertAdjacentHTML('beforeend', typeBadge(node.t) + '<span class="nname">' + esc(name) + '</span>' +
        '<span class="nprev">' + (node.t === T.Compound ? node.v.entries.length + ' 项' : node.v.items.length + ' 项') + '</span>');
      const kids = el('div', 'kids hidden');
      arrow.onclick = () => {
        const open = !kids.classList.contains('hidden');
        kids.classList.toggle('hidden', open);
        arrow.textContent = open ? '▸' : '▾';
      };
      wrap.appendChild(line);
      wrap.appendChild(kids);
      const fill = () => {
        kids.innerHTML = '';
        if (node.t === T.Compound) {
          for (const [k, v] of node.v.entries) kids.appendChild(treeRow(v, k, depth + 1, editable));
        } else {
          node.v.items.forEach((v, i) => kids.appendChild(treeRow(v, '[' + i + ']', depth + 1, editable)));
        }
      };
      let filled = false;
      arrow.addEventListener('click', () => { if (!filled) { fill(); filled = true; } });
      return wrap;
    }
    // 叶子
    let preview = '', isBin = false;
    if (node.t === T.String) {
      if (node.bin && node.b) {
        // scriptData / StorageKey 这类「标称 String 实际是二进制」的字段：
        // 显示字节数 + 十六进制片段，别把 U+FFFD 摊在屏幕上
        isBin = true;
        preview = '『二进制 ' + node.b.length + ' 字节』 ' + hexSnippet(node.b, 14);
      } else {
        preview = JSON.stringify(node.v.length > 60 ? node.v.slice(0, 60) + '…' : node.v);
      }
    }
    else if (node.t === T.ByteArray) { isBin = true; preview = node.v.length + ' 字节 · ' + hexSnippet(node.v, 14); }
    else if (node.t === T.IntArray || node.t === T.LongArray) preview = node.v.length + ' 项';
    else preview = String(node.v);
    line.insertAdjacentHTML('beforeend', typeBadge(node.t) + '<span class="nname">' + esc(name) + '</span><span class="nprev' + (isBin ? ' nbin' : '') + '">' + esc(preview) + '</span>');
    if (editable && !isBin) {
      line.classList.add('editable');
      line.onclick = () => {
        const inp = el('input', 'ninput');
        inp.value = node.v;
        line.replaceWith(inp);
        inp.focus();
        const commit = (ok) => {
          if (ok) {
            const v = inp.value;
            if (node.t === T.String) { node.v = v; node.b = null; }
            else if (node.t === T.Byte || node.t === T.Short || node.t === T.Int) node.v = parseInt(v, 10) | 0;
            else if (node.t === T.Long) node.v = String(BigInt(v));
            else if (node.t === T.Float || node.t === T.Double) node.v = parseFloat(v);
          }
          const back = treeRow(node, name, depth, editable);
          inp.replaceWith(back);
          if (ok && curPlayer) markDirty();
        };
        inp.onblur = () => commit(true);
        inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.onblur = null; commit(false); } };
      };
    }
    wrap.appendChild(line);
    return wrap;
  }

  // ---------------------------------------------------------------- 全部数据
  let keyPage = 0;
  const PAGE = 200;
  function renderKeys() {
    const q = ($('ksearch').value || '').trim().toLowerCase();
    let keys = state.keys;
    if (q) keys = keys.filter(k => k.toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(keys.length / PAGE));
    if (keyPage >= pages) keyPage = 0;
    const slice = keys.slice(keyPage * PAGE, keyPage * PAGE + PAGE);
    $('kpage').textContent = (keyPage + 1) + ' / ' + pages + '（共 ' + keys.length + ' 个键）';
    $('klist').innerHTML = slice.map(k => {
      const v = state.map.get(k);
      const nbt = PIPE.isNbtValue(v.value);
      const lbl = keyLabel(k);
      const shown = lbl != null ? lbl : (k.length > 70 ? k.slice(0, 70) + '…' : k);
      return '<div class="krow" data-k="' + encodeURIComponent(k) + '">' +
        '<span class="ktag ' + (nbt ? 'isnbt' : 'isbin') + '">' + (nbt ? 'NBT' : 'BIN') + '</span>' +
        '<span class="kname mono' + (lbl != null ? ' kbin' : '') + '">' + esc(shown) + '</span>' +
        '<span class="ksize">' + v.value.length + ' B</span></div>';
    }).join('');
    $('klist').querySelectorAll('.krow').forEach(r => r.onclick = () => showKey(decodeURIComponent(r.dataset.k)));
    $('klist').querySelectorAll('.krow').forEach(r => r.classList.toggle('on', decodeURIComponent(r.dataset.k) === curKey));
  }

  function showKey(k) {
    curKey = k;
    $('klist').querySelectorAll('.krow').forEach(r => r.classList.toggle('on', decodeURIComponent(r.dataset.k) === k));
    const v = state.map.get(k);
    $('ktitle').textContent = k;
    $('ksub').textContent = v.value.length + ' 字节 · ' + (PIPE.isNbtValue(v.value) ? 'NBT Compound' : '二进制');
    const box = $('kbody');
    box.innerHTML = '';
    if (PIPE.isNbtValue(v.value)) {
      let parsed;
      try { parsed = CORE.nbtParseAuto(v.value); } catch (e) { box.appendChild(el('div', 'note', 'NBT 解析失败：' + e.message)); return; }
      box.appendChild(el('div', 'note', '可解析 · ' + parsed.root.v.entries.length + ' 个顶层标签（点值可改，改完记得导出）'));
      box.appendChild(treeRow(parsed.root, 'root', 0, true));
    } else {
      const hex = [];
      const n = Math.min(v.value.length, 512);
      for (let i = 0; i < n; i++) hex.push(v.value[i].toString(16).padStart(2, '0'));
      let lines = [];
      for (let i = 0; i < hex.length; i += 32) lines.push(hex.slice(i, i + 32).join(' '));
      const pre = el('pre', 'hex');
      pre.textContent = lines.join('\n') + (v.value.length > n ? '\n…（共 ' + v.value.length + ' 字节）' : '');
      box.appendChild(pre);
    }
  }

  // ---------------------------------------------------------------- 计分板
  /* scoreboard 在存档里是一个 Compound，不是一条条记录：
   *   Objectives[{Name, DisplayName, Criteria, Scores[{Score, ScoreboardId}]}]  ← 分数在这
   *   Entries[{IdentityType, PlayerId, ScoreboardId}]                            ← 身份表
   *   DisplayObjectives[{Name, ObjectiveName, SortOrder}]                        ← 侧边栏显示哪个
   * 所以「谁多少分」要跳两次：Scores.ScoreboardId → Entries.PlayerId → 玩家 UniqueID → 昵称。
   */
  let sb = null, sbSel = null, sbPage = 0;
  const SB_PAGE = 300;

  function loadScoreboard() {
    const e = state && state.map.get('scoreboard');
    if (!e || !PIPE.isNbtValue(e.value)) return null;
    let parsed;
    try { parsed = CORE.nbtParseAuto(e.value); } catch (err) { return null; }
    const top = new Map(parsed.root.v.entries);
    const ids = new Map();
    const ent = top.get('Entries');
    if (ent && ent.t === T.List) {
      for (const it of ent.v.items) {
        if (it.t !== T.Compound) continue;
        const sid = CORE.nbtGet(it, 'ScoreboardId');
        if (!sid) continue;
        ids.set(sid.v, {
          type: (CORE.nbtGet(it, 'IdentityType') || {}).v,
          pid: (CORE.nbtGet(it, 'PlayerId') || {}).v
        });
      }
    }
    // 分数里存的是玩家 UniqueID（Long），跟 player_uid_xxx 那个网易 uid 不是一回事
    const byUid = new Map();
    for (const p of state.players) {
      const u = CORE.nbtGet(p.parsed.root, 'UniqueID');
      if (u) byUid.set(String(u.v), p);
    }
    return { parsed, top, ids, byUid, dirty: false };
  }

  const sbObjectives = () => {
    const n = sb && sb.top.get('Objectives');
    return (n && n.t === T.List) ? n.v.items : [];
  };
  const sbName = o => (CORE.nbtGet(o, 'Name') || {}).v || '';
  const sbScoresOf = o => {
    const s = CORE.nbtGet(o, 'Scores');
    return (s && s.t === T.List) ? s.v.items : [];
  };
  function sbDisplay(o) {
    const d = CORE.nbtGet(o, 'DisplayName');
    return (d && d.v) || sbName(o) || '(无名)';
  }
  const sbStrip = s => String(s == null ? '' : s).replace(/§[0-9a-fk-or]/gi, '');

  function sbSidebarName() {
    const dl = sb && sb.top.get('DisplayObjectives');
    if (!dl || dl.t !== T.List) return '';
    for (const it of dl.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === 'sidebar') return (CORE.nbtGet(it, 'ObjectiveName') || {}).v || '';
    }
    return '';
  }

  function sbWho(sid) {
    const id = sb.ids.get(sid);
    if (!id) return { main: '(身份已丢失)', sub: '', cls: 'sbmiss' };
    if (id.type === 1) {
      const p = sb.byUid.get(String(id.pid));
      if (p) {
        if (!p._d) p._d = PIPE.readPlayer(p);
        return { main: p._d.nick || p._d.uid || p.key, sub: p._d.uid ? '#' + p._d.uid : '', cls: '' };
      }
      return { main: '玩家 ' + id.pid, sub: '无对应记录', cls: 'sbmiss' };
    }
    if (id.type === 2) return { main: '实体 ' + id.pid, sub: 'IdentityType 2', cls: 'sbmiss' };
    return { main: '假名 ' + id.pid, sub: '', cls: 'sbfake' };
  }

  function renderScoreboard() {
    if (!state) return;
    if (!sb) sb = loadScoreboard();
    state.sb = sb;
    if (!sb) {
      $('sbList').innerHTML = '';
      $('sbCount').textContent = '没有 scoreboard';
      $('sbEmpty').textContent = '这个存档里没有 scoreboard 键（没人用过 /scoreboard）';
      $('sbEmpty').classList.remove('hidden');
      $('sbDetail').classList.add('hidden');
      return;
    }
    const all = sbObjectives();
    const q = ($('sbSearch').value || '').trim().toLowerCase();
    const side = sbSidebarName();
    const rows = all.map((o, i) => ({ o, i })).filter(r => {
      if (!q) return true;
      return (sbStrip(sbDisplay(r.o)) + ' ' + sbName(r.o)).toLowerCase().includes(q);
    });
    $('sbCount').textContent = rows.length + ' / ' + all.length;
    $('sbList').innerHTML = rows.map(r => {
      const nm = sbName(r.o);
      return '<tr data-i="' + r.i + '"' + (r.o === sbSel ? ' class="sel"' : '') + '>' +
        '<td>' + esc(sbStrip(sbDisplay(r.o))) + (nm && nm === side ? '<span class="sbside">侧边栏</span>' : '') + '</td>' +
        '<td class="sbsub">' + esc(nm) + '</td>' +
        '<td class="sbsub">' + sbScoresOf(r.o).length + '</td></tr>';
    }).join('');
    $('sbList').querySelectorAll('tr').forEach(tr => {
      tr.onclick = () => { sbSel = all[+tr.dataset.i]; sbPage = 0; renderScoreboard(); };
    });
    if (sbSel && all.indexOf(sbSel) < 0) sbSel = null;
    if (!sbSel) {
      $('sbEmpty').classList.remove('hidden');
      $('sbDetail').classList.add('hidden');
      return;
    }
    $('sbEmpty').classList.add('hidden');
    $('sbDetail').classList.remove('hidden');
    $('sbTitle').textContent = sbStrip(sbDisplay(sbSel));
    $('sbSub').textContent = 'Name: ' + sbName(sbSel) + ' · ' + (CORE.nbtGet(sbSel, 'Criteria') || {}).v +
      ' · ' + sbScoresOf(sbSel).length + ' 条分数';
    renderSbScores();
  }

  function renderSbScores() {
    if (!sbSel) return;
    const items = sbScoresOf(sbSel);
    const rows = items.map((node, i) => ({
      i, node,
      score: (CORE.nbtGet(node, 'Score') || {}).v || 0,
      sid: (CORE.nbtGet(node, 'ScoreboardId') || {}).v
    })).sort((a, b) => b.score - a.score);
    const q = ($('sbQ').value || '').trim().toLowerCase();
    const view = q ? rows.filter(r => {
      if (String(r.score).indexOf(q) >= 0) return true;
      return String(sbWho(r.sid).main).toLowerCase().includes(q);
    }) : rows;
    const pages = Math.max(1, Math.ceil(view.length / SB_PAGE));
    if (sbPage >= pages) sbPage = 0;
    const slice = view.slice(sbPage * SB_PAGE, sbPage * SB_PAGE + SB_PAGE);
    $('sbPage').textContent = (sbPage + 1) + ' / ' + pages + '（共 ' + view.length + ' 条）';
    $('sbScores').innerHTML = slice.map((r, k) => {
      const w = sbWho(r.sid);
      return '<tr>' +
        '<td class="sbsub">' + (k + 1) + '</td>' +
        '<td class="sbcell sbscore" data-i="' + r.i + '">' + r.score + '</td>' +
        '<td class="sbwho"><span class="' + w.cls + '">' + esc(w.main) + '</span>' +
        (w.sub ? '<span class="k">' + esc(w.sub) + '</span>' : '') + '</td>' +
        '<td class="sbsub">' + esc(String(r.sid)) + '</td>' +
        '<td><button class="sbdel" data-del="' + r.i + '">删</button></td></tr>';
    }).join('');
    $('sbScores').querySelectorAll('td.sbcell').forEach(td => { td.onclick = () => editSbScore(items[+td.dataset.i], td); });
    $('sbScores').querySelectorAll('[data-del]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const i = +b.dataset.del;
        items.splice(i, 1);
        sb.dirty = true; markDirty(null);
        renderScoreboard();
      };
    });
  }

  function editSbScore(node, td) {
    const sn = CORE.nbtGet(node, 'Score');
    if (!sn) return;
    const inp = el('input', 'sbnum');
    inp.type = 'number';
    inp.value = sn.v;
    td.innerHTML = '';
    td.appendChild(inp);
    inp.focus(); inp.select();
    const done = (ok) => {
      if (ok) {
        const v = parseInt(inp.value, 10);
        if (!isNaN(v) && v !== sn.v) { sn.v = v | 0; sb.dirty = true; markDirty(null); }
      }
      renderSbScores();
      $('sbTip').textContent = '点分数可直接改';
    };
    inp.onblur = () => done(true);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { inp.onblur = null; done(true); }
      if (e.key === 'Escape') { inp.onblur = null; done(false); }
    };
  }

  function sbAddObjective() {
    const nm = mfield('text', '名称', 'new_score', '英文/数字/下划线，游戏里 /scoreboard objectives add 用这个');
    const dn = mfield('text', '显示名', '新计分项', '侧边栏上看到的名字，可以写中文，§ 开头是颜色代码');
    openModal('新建计分项', [nm.wrap, dn.wrap], [
      { label: '取消', onClick: closeModal },
      {
        label: '创建', primary: true, onClick: () => {
          const name = String(nm.value()).trim();
          if (!name) { $('sbTip').textContent = '名称不能为空'; return; }
          if (sbObjectives().some(o => sbName(o) === name)) { $('sbTip').textContent = '已经有同名计分项了'; return; }
          let list = sb.top.get('Objectives');
          if (!list) {
            list = { t: T.List, v: { el: T.Compound, items: [] } };
            sb.parsed.root.v.entries.push(['Objectives', list]);
            sb.top.set('Objectives', list);
          }
          const item = { t: T.Compound, v: { entries: [
            ['Criteria', { t: T.String, v: 'dummy' }],
            ['DisplayName', { t: T.String, v: String(dn.value()) || name }],
            ['Name', { t: T.String, v: name }],
            ['Scores', { t: T.List, v: { el: T.Compound, items: [] } }]
          ] } };
          list.v.items.push(item);
          sbSel = item; sb.dirty = true; markDirty(null);
          closeModal();
          renderScoreboard();
          log('已新建计分项 ' + name);
        }
      }
    ]);
  }

  function sbSetSidebar() {
    if (!sbSel) return;
    const name = sbName(sbSel);
    let dl = sb.top.get('DisplayObjectives');
    if (!dl) {
      dl = { t: T.List, v: { el: T.Compound, items: [] } };
      sb.parsed.root.v.entries.push(['DisplayObjectives', dl]);
      sb.top.set('DisplayObjectives', dl);
    }
    let hit = null;
    for (const it of dl.v.items) {
      const n = CORE.nbtGet(it, 'Name');
      if (n && n.v === 'sidebar') hit = it;
    }
    if (hit) {
      const o = CORE.nbtGet(hit, 'ObjectiveName');
      if (o) { o.v = name; o.b = null; }
      else hit.v.entries.push(['ObjectiveName', { t: T.String, v: name }]);
    } else {
      dl.v.items.push({ t: T.Compound, v: { entries: [
        ['Name', { t: T.String, v: 'sidebar' }],
        ['ObjectiveName', { t: T.String, v: name }],
        ['SortOrder', { t: T.Int, v: 1 }]
      ] } });
    }
    sb.dirty = true; markDirty(null);
    renderScoreboard();
    log('侧边栏已切到「' + sbStrip(sbDisplay(sbSel)) + '」');
  }

  function sbZero() {
    if (!sbSel) return;
    const list = sbScoresOf(sbSel);
    for (const n of list) {
      const s = CORE.nbtGet(n, 'Score');
      if (s) s.v = 0;
    }
    sb.dirty = true; markDirty(null);
    renderSbScores();
    log('「' + sbStrip(sbDisplay(sbSel)) + '」的 ' + list.length + ' 条分数已清零');
  }

  function sbDrop() {
    if (!sbSel) return;
    const name = sbName(sbSel);
    openModal('删除计分项', [
      el('div', 'note', '将删除「' + sbStrip(sbDisplay(sbSel)) + '」以及它的 ' + sbScoresOf(sbSel).length + ' 条分数。')
    ], [
      { label: '取消', onClick: closeModal },
      {
        label: '确认删除', primary: true, onClick: () => {
          const list = sb.top.get('Objectives');
          const i = list.v.items.indexOf(sbSel);
          if (i >= 0) list.v.items.splice(i, 1);
          sbSel = null; sb.dirty = true; markDirty(null);
          closeModal();
          renderScoreboard();
          log('已删除计分项 ' + name);
        }
      }
    ]);
  }

  // 往当前计分项里加一个玩家
  // 原理：Entries 里每个身份是 {IdentityType, PlayerId, ScoreboardId}，
  //      PlayerId 就是玩家 NBT 的 UniqueID（Long）；新身份号由顶层 LastUniqueID +1 分配。
  //      分数条目只有 {Score, ScoreboardId} 两个字段，结构确定。
  function sbAddPlayer() {
    if (!sb || !sbSel) return;
    const lastNode = sb.top.get('LastUniqueID');
    if (!lastNode || lastNode.t !== T.Long) {
      openModal('加不了', [
        el('div', 'note', '这个存档的 scoreboard 里没有 LastUniqueID，没法安全分配新的 ScoreboardId。' +
          '硬凑一个号有可能会和游戏之后新建的身份撞号，所以这里不做。')
      ], [{ label: '知道了', onClick: closeModal }]);
      return;
    }

    const inp = el('input');
    inp.placeholder = '输入昵称或 UID 过滤…';
    const tip = el('div', 'note', '');
    const list = el('div', 'sbcand');

    const draw = () => {
      const q2 = String(inp.value || '').trim().toLowerCase();
      const hits = [];
      for (const p of state.players) {
        if (!p._d) p._d = PIPE.readPlayer(p);
        const d = p._d;
        if (q2 && !(String(d.nick).toLowerCase().includes(q2) || String(d.uid).includes(q2))) continue;
        hits.push(p);
        if (hits.length >= 30) break;
      }
      list.innerHTML = hits.length ? hits.map((p, i) => {
        const d = p._d;
        return '<div class="sbrow" data-i="' + i + '">' +
          '<b>' + esc(d.nick || '—') + '</b>' +
          '<span class="k">' + esc(d.uid || '') + '</span>' +
          (hasFb(d) ? '<span class="fb">有快建</span>' : '') + '</div>';
      }).join('') : '<div class="sbrow"><span class="k">没有匹配的玩家</span></div>';
      list.querySelectorAll('.sbrow[data-i]').forEach(r => {
        r.onclick = () => pick(hits[+r.dataset.i]);
      });
    };

    const pick = (p) => {
      const d = p._d;
      const uidNode = CORE.nbtGet(p.parsed.root, 'UniqueID');
      if (!uidNode) { tip.textContent = '这个玩家记录里没有 UniqueID，加不了。'; return; }
      const pid = String(uidNode.v);

      // 已有身份就复用，不重复建
      let sid = null;
      for (const [id, info] of sb.ids) {
        if (info.type === 1 && String(info.pid) === pid) { sid = id; break; }
      }

      const scores = sbScoresOf(sbSel);
      if (sid !== null && scores.some(n => String((CORE.nbtGet(n, 'ScoreboardId') || {}).v) === String(sid))) {
        tip.textContent = (d.nick || d.uid) + ' 已经在本项里了（ScoreboardId ' + sid + '）';
        return;
      }

      let created = false;
      if (sid === null) {
        const nid = (BigInt(String(lastNode.v)) + 1n).toString();
        lastNode.v = nid;
        let ent = sb.top.get('Entries');
        if (!ent) {
          ent = { t: T.List, v: { el: T.Compound, items: [] } };
          sb.parsed.root.v.entries.push(['Entries', ent]);
          sb.top.set('Entries', ent);
        }
        ent.v.items.push({ t: T.Compound, v: { entries: [
          ['IdentityType', { t: T.Byte, v: 1 }],
          ['PlayerId', { t: T.Long, v: pid }],
          ['ScoreboardId', { t: T.Long, v: nid }]
        ] } });
        sb.ids.set(nid, { type: 1, pid });
        sid = nid;
        created = true;
      }

      scores.push({ t: T.Compound, v: { entries: [
        ['Score', { t: T.Int, v: 0 }],
        ['ScoreboardId', { t: T.Long, v: String(sid) }]
      ] } });
      sb.dirty = true; markDirty(null);
      closeModal();
      renderScoreboard();
      $('sbTip').textContent = '已加 ' + (d.nick || d.uid) + '，分数 0' +
        (created ? '（新身份 ' + sid + '）' : '（沿用身份 ' + sid + '）');
    };

    openModal('加玩家到「' + sbStrip(sbDisplay(sbSel)) + '」', [inp, tip, list], [
      { label: '取消', onClick: closeModal }
    ]);
    inp.oninput = draw;
    draw();
    inp.focus();
  }

  // ---------------------------------------------------------------- 导出
  async function doExport() {
    if (!state) return;
    $('exportBtn').disabled = true;
    $('dirtyTip').textContent = '正在重建数据库…';
    try {
      const out = await PIPE.exportArchive(state, {
        name: '存档_已修改_' + stamp() + '.zip',
        onProgress: (s) => { $('dirtyTip').textContent = s; }
      });
      const bs = CORE.buildStats();
      const vr = state.lastVerify;
      if (vr) {
        console.log('导出自检：' + vr.ssts + ' 个 SST / ' + (vr.entries || vr.keys) + ' 条记录 / ' +
          (vr.ok ? '块尾 CRC 与索引结构全部通过' : vr.problems.length + ' 处问题'));
      }
      console.log('构建统计: 文件 ' + bs.files + '，块 ' + bs.blocks + '（压缩 ' + bs.compressed + '），' +
        '原始 ' + (bs.rawBytes / 1048576).toFixed(1) + ' MB → 存储 ' + (bs.storedBytes / 1048576).toFixed(1) + ' MB' +
        '；压缩异常 ' + (bs.failed || 0) + ' 块，压不动 ' + (bs.notSmaller || 0) + ' 块' +
        (bs.firstError ? '，首个错误：' + bs.firstError : ''));
      download(out.name, out.data);
      $('dirtyTip').textContent = '已导出（' + (out.data.length / 1048576).toFixed(1) + ' MB）';
      $('dirtyTip').classList.remove('on');
    } catch (e) {
      const p = (e && e.problems) || [];
      $('dirtyTip').textContent = '导出失败：' + (e && e.message || e) +
        (p.length ? ' 例：' + p[0] : '');
      if (p.length) console.error('导出自检问题：\n' + p.slice(0, 20).join('\n'));
      console.error(e);
    }
    $('exportBtn').disabled = false;
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(name, data) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------------------------------------------------------- tab
  function switchTab(name) {
    ['overview', 'players', 'score', 'mods', 'world', 'data'].forEach(t => {
      $('view-' + t).classList.toggle('hidden', t !== name);
      $('tab-' + t).classList.toggle('on', t === name);
    });
    if (name === 'overview') renderIdent();
    if (name === 'data') renderKeys();
    if (name === 'score') renderScoreboard();
    if (name === 'mods') renderModsTab();
    if (name === 'world') renderWorld();
  }

  // ---------------------------------------------------------------- 绑定
  window.addEventListener('DOMContentLoaded', () => {
    $('pickFile').onclick = () => $('fileInput').click();
    $('fileInput').onchange = e => {
      const arr = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      openFiles(arr);
    };
    $('pickDir').onclick = () => $('dirInput').click();
    $('dirInput').onchange = e => {
      const arr = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      openFiles(arr);
    };
    $('tab-overview').onclick = () => switchTab('overview');
    $('tab-players').onclick = () => switchTab('players');
    $('tab-score').onclick = () => switchTab('score');
    $('tab-mods').onclick = () => switchTab('mods');
    $('tab-world').onclick = () => switchTab('world');
    $('tab-data').onclick = () => switchTab('data');
    $('sbAdd').onclick = sbAddObjective;
    $('sbAddPlayer').onclick = sbAddPlayer;
    $('onlyFb').onclick = () => {
      onlyFb = !onlyFb;
      $('onlyFb').classList.toggle('primary', onlyFb);
      renderPlayers();
    };
    $('sbSidebar').onclick = sbSetSidebar;
    $('sbZero').onclick = sbZero;
    $('sbDrop').onclick = sbDrop;
    $('sbSearch').oninput = () => renderScoreboard();
    $('sbQ').oninput = () => { sbPage = 0; renderSbScores(); };
    $('sbPrev').onclick = () => { sbPage = Math.max(0, sbPage - 1); renderSbScores(); };
    $('sbNext').onclick = () => { sbPage++; renderSbScores(); };
    $('selAll').onclick = () => { selectAllVisible(true); };
    $('selNone').onclick = () => { state.sel.clear(); renderPlayers(); };
    $('batchBtn').onclick = openBatchModal;
    $('ckAll').onclick = (e) => selectAllVisible(e.target.checked);
    $('mClose').onclick = closeModal;
    $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
    $('psearch').oninput = e => { playerFilter = e.target.value; renderPlayers(); };
    $('ksearch').oninput = () => { keyPage = 0; renderKeys(); };
    $('kprev').onclick = () => { keyPage = Math.max(0, keyPage - 1); renderKeys(); };
    $('knext').onclick = () => { keyPage++; renderKeys(); };
    $('exportBtn').onclick = doExport;
    $('jsonBtn').onclick = () => {
      if (!state) return;
      download('玩家清单_' + stamp() + '.json', new Blob([PIPE.playersToJson(state)], { type: 'application/json' }));
    };

    // 拖拽
    const dz = document.body;
    ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); $('drop').classList.add('on'); }));
    ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, e => {
      e.preventDefault();
      if (t === 'dragleave' && e.relatedTarget) return;
      $('drop').classList.remove('on');
    }));
    dz.addEventListener('drop', async e => {
      const items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        const entries = [];
        for (const it of items) { const en = it.webkitGetAsEntry(); if (en) entries.push(en); }
        const files = [];
        for (const en of entries) await walkEntry(en, files);
        if (files.length) openFiles(files);
      } else if (e.dataTransfer.files.length) {
        openFiles(e.dataTransfer.files);
      }
    });
  });

  async function walkEntry(entry, out, path) {
    path = path || '';
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name });
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const en of batch) await walkEntry(en, out, path + entry.name + '/');
      }
    }
  }

  // ---------------------------------------------------------------- 选择与批量
  function updateSelCount() {
    const n = state && state.sel ? state.sel.size : 0;
    const b = $('batchBtn');
    if (b) { b.disabled = n === 0; b.textContent = n ? '批量改权限（' + n + '）' : '批量改权限'; }
    const ck = $('ckAll');
    if (ck) ck.checked = false;
  }

  function selectAllVisible(on) {
    if (!state) return;
    const q = playerFilter.trim().toLowerCase();
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (q) {
        const d = p._d || (p._d = PIPE.readPlayer(p));
        if (!(String(d.nick).toLowerCase().includes(q) || String(d.uid).includes(q))) continue;
      }
      if (on) state.sel.add(i); else state.sel.delete(i);
    }
    renderPlayers();
    log((on ? '已选 ' : '已取消 ') + state.sel.size + ' 个玩家');
  }

  function openBatchModal() {
    if (!state || !state.sel.size) return;
    const n = state.sel.size;
    const lv = mfield('number', '快建等级', '', '留空 = 不改；0 关闭 / 1 普通 / 2 全开');
    const cl = mfield('select', '跨世界读取', [['', '不改'], ['1', '开'], ['0', '关']]);
    const cs = mfield('select', '跨世界保存', [['', '不改'], ['1', '开'], ['0', '关']]);
    const pm = mfield('number', '玩家权限等级', '', '留空 = 不改；0 普通 / 1 管理员 / 2 服主');
    openModal('批量修改 ' + n + ' 个玩家', [lv.wrap, cl.wrap, cs.wrap, pm.wrap], [
      { label: '取消', onClick: closeModal },
      {
        label: '应用到 ' + n + ' 人', primary: true, onClick: () => {
          applyBatch({
            level: lv.value() === '' ? null : parseInt(lv.value(), 10),
            crossLoad: cl.value() === '' ? null : cl.value() === '1',
            crossSave: cs.value() === '' ? null : cs.value() === '1',
            perm: pm.value() === '' ? null : parseInt(pm.value(), 10)
          });
          closeModal();
        }
      }
    ]);
  }

  function applyBatch(o) {
    let n = 0, skipped = 0;
    for (const i of state.sel) {
      const p = state.players[i];
      if (!p) continue;
      let changed = false;
      if (o.level != null || o.crossLoad != null || o.crossSave != null) {
        let fb = null;
        try { fb = PIPE.readMods(p).find(m => m.id === '7stars_fastbuilder' && m.safe); } catch (e) { }
        if (fb) {
          if (o.level != null) CORE.fbSet(fb, 'level', { t: 'num', v: o.level | 0 });
          if (o.crossLoad != null) CORE.fbSet(fb, 'cross_load', { t: 'bool', v: o.crossLoad });
          if (o.crossSave != null) CORE.fbSet(fb, 'cross_save', { t: 'bool', v: o.crossSave });
          PIPE.writeMods(p, [fb]);
          changed = true;
        } else skipped++;
      }
      if (o.perm != null) {
        const a = CORE.nbtGet(p.parsed.root, 'permissionsLevel');
        const b = CORE.nbtGet(p.parsed.root, 'playerPermissionsLevel');
        if (a) a.v = o.perm | 0;
        if (b) b.v = o.perm | 0;
        changed = true;
      }
      if (changed) { p.dirty = true; p._d = null; n++; }
    }
    markDirty(null);
    renderPlayers();
    log('批量修改完成：' + n + ' 个玩家' + (skipped ? '；' + skipped + ' 个没有快建数据，跳过' : ''));
  }

  // ---------------------------------------------------------------- 弹窗
  function openModal(title, rows, buttons) {
    $('mTitle').textContent = title;
    const body = $('mBody');
    body.innerHTML = '';
    (rows || []).forEach(r => body.appendChild(r));
    const foot = $('mFoot');
    foot.innerHTML = '';
    (buttons || []).forEach(b => {
      const btn = el('button', b.primary ? 'primary' : '', b.label);
      btn.onclick = b.onClick;
      foot.appendChild(btn);
    });
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  function mfield(type, label, val, tip) {
    const wrap = el('div', 'mrow');
    wrap.appendChild(el('label', null, label));
    let input;
    if (type === 'select') {
      input = el('select');
      (val || []).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; input.appendChild(o); });
    } else {
      input = el('input');
      input.type = type;
      if (val !== '' && val != null) input.value = val;
    }
    wrap.appendChild(input);
    if (tip) wrap.appendChild(el('div', 'tip', tip));
    return { wrap, value: () => input.value, el: input };
  }

  // ---------------------------------------------------------------- 背包
  function buildInv(p, inv) {
    const box = el('div');
    const refresh = () => renderPlayerFields();
    const group = (title, items, cols, from) => {
      if (!items || !items.length) return;
      const t = el('div', 'invtitle');
      t.innerHTML = '<span>' + esc(title) + '</span><span class="line"></span><span class="mono">' + items.length + ' 格</span>';
      box.appendChild(t);
      const g = el('div', 'invgrid');
      g.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0,1fr))';
      items.forEach((it, i) => g.appendChild(invCell(p, it, from + i, refresh)));
      box.appendChild(g);
    };
    if (inv.inv) {
      group('主背包', inv.inv.slice(9, 36), 9, 9);
      group('快捷栏', inv.inv.slice(0, 9), 9, 0);
    }
    const wear = (inv.armor || []).slice();
    if (inv.offhand && inv.offhand.length) wear.push(inv.offhand[0]);
    if (wear.length) group('护甲 / 副手', wear, Math.min(6, wear.length), 100);
    if (inv.ender) group('末影箱', inv.ender, 9, 0);
    if (!inv.inv && !wear.length && !inv.ender) box.appendChild(el('div', 'note', '这条记录里没有背包数据'));
    return box;
  }

  function invCell(p, item, slot, refresh) {
    const d = el('div', 'icell' + (item.empty ? ' empty' : ''));
    d.innerHTML = '<div class="iname">' + esc(item.empty ? '空' : item.name) + '</div>' +
      '<div class="islot">' + slot + '</div>' +
      (item.empty ? '' : '<div class="icnt">' + (item.count > 1 ? '×' + item.count : '') + '</div>');
    d.title = item.empty ? '点击放入物品' : (item.id + (item.damage ? ' · 损伤 ' + item.damage : '') + ' ×' + item.count);
    d.onclick = () => openItemEditor(p, item, slot, refresh);
    return d;
  }

  function openItemEditor(p, item, slot, refresh) {
    const id = mfield('text', '物品 ID', item.id || 'minecraft:', '例如 minecraft:diamond_sword');
    const cnt = mfield('number', '数量', item.empty ? 1 : item.count);
    const dmg = mfield('number', '损伤值', item.damage || 0, '羊毛、染料这类靠它区分颜色/种类');
    openModal((item.empty ? '放入物品' : '编辑物品') + ' · 槽位 ' + slot, [id.wrap, cnt.wrap, dmg.wrap], [
      { label: '取消', onClick: closeModal },
      {
        label: '清空此格', onClick: () => {
          PIPE.setItem(item, '', 0, 0);
          closeModal();
          refresh();
          markDirty(p);
        }
      },
      {
        label: '保存', primary: true, onClick: () => {
          const nid = String(id.value()).trim();
          const n = Math.max(0, parseInt(cnt.value(), 10) || 0);
          const dd = Math.max(0, parseInt(dmg.value(), 10) || 0);
          PIPE.setItem(item, nid, n, dd);
          closeModal();
          refresh();
          markDirty(p);
        }
      }
    ]);
  }

  // ---------------------------------------------------------------- 模组
  const MOD_LABEL = {
    '7stars_fastbuilder': '7 星快建',
    'parterner_talk_main_key': '搭档对话',
    'AetherTpaPoint': '以太传送点'
  };
  const FIELD_LABEL = {
    '7stars_fastbuilder': {
      level: '快建等级', cross_load: '跨世界读取', cross_save: '跨世界保存',
      name: '昵称', hud_pos: 'HUD 位置'
    }
  };
  function modLabel(id) { return MOD_LABEL[id] || id; }

  function renderModSection(p, box) {
    box.innerHTML = '';
    let mods = [];
    try { mods = PIPE.readMods(p); } catch (e) { mods = []; }
    if (!mods.length) {
      box.appendChild(el('div', 'note', '这名玩家的 scriptData 里没有可识别的模组数据'));
      return;
    }
    for (const m of mods) {
      const head = el('div', 'invtitle');
      head.innerHTML = '<b style="color:var(--txt)">' + esc(modLabel(m.id)) + '</b>' +
        '<span class="mono" style="color:var(--dim2)">' + esc(m.id) + '</span>' +
        (m.safe ? '<span class="badge-rw">可改</span>' : '<span class="badge-ro">只读</span>');
      box.appendChild(head);
      const g = el('div', 'grid');
      for (const f of m.fields) g.appendChild(modField(p, m, f));
      box.appendChild(g);
    }
  }

  function modField(p, m, f) {
    const label = (FIELD_LABEL[m.id] || {})[f.key] || f.key;
    const v = f.node;
    if (!m.safe) return readonly(label, v && v.t === 'str' ? v.v : String(v && v.v));
    if (v.t === 'bool') return boolInput(label, v.v, val => { v.v = val; writeModNow(p, m); });
    if (v.t === 'num') return numInput(label, v.v, 1, val => { v.v = val; writeModNow(p, m); });
    if (v.t === 'str') {
      const wrap = el('div', 'row');
      wrap.innerHTML = '<label>' + esc(label) + '</label>';
      const inp = el('input');
      inp.type = 'text';
      inp.value = v.v;
      inp.onchange = () => { v.v = inp.value; writeModNow(p, m); };
      wrap.appendChild(inp);
      return wrap;
    }
    return readonly(label, v.t === 'null' ? '（空）' : String(v.v));
  }

  /* 写完要立刻重画这一段：字节长度可能变了，下一处编辑的偏移就不能再用旧的 */
  function writeModNow(p, m) {
    PIPE.writeMods(p, [m]);
    p.dirty = true;
    p._d = null;
    markDirty(null);
    if (p._modBox) renderModSection(p, p._modBox);
  }

  function renderModsTab() {
    if (!state) return;
    const agg = new Map();
    for (const p of state.players) {
      let mods = [];
      try { mods = PIPE.readMods(p); } catch (e) { continue; }
      for (const m of mods) {
        let a = agg.get(m.id);
        if (!a) { a = { id: m.id, n: 0, safe: m.safe, fields: new Set() }; agg.set(m.id, a); }
        a.n++;
        m.fields.forEach(f => a.fields.add(f.key));
      }
    }
    const cards = [...agg.values()].sort((a, b) => b.n - a.n);
    if (!cards.length) {
      $('modcards').innerHTML = '<div class="note">这个存档的玩家数据里没有识别到模组块</div>';
      $('moddetail').innerHTML = '';
      return;
    }
    $('modcards').innerHTML = cards.map(c =>
      '<div class="mcard" data-id="' + encodeURIComponent(c.id) + '">' +
      '<div class="mid">' + esc(modLabel(c.id)) +
      (c.safe ? '<span class="badge-rw">可改</span>' : '<span class="badge-ro">只读</span>') + '</div>' +
      '<div class="mnum">' + c.n + '<span style="font-size:12px;color:var(--dim2);margin-left:4px">个玩家</span></div>' +
      '<div class="mnote">字段：' + esc([...c.fields].join(', ').slice(0, 80)) + '</div></div>').join('');
    $('modcards').querySelectorAll('.mcard').forEach(c => {
      c.onclick = () => renderModDetail(decodeURIComponent(c.dataset.id));
    });
    $('moddetail').innerHTML = '';
  }

  function modVal(n) {
    if (!n) return '—';
    if (n.t === 'bool') return n.v ? '开' : '关';
    if (n.t === 'null') return '—';
    if (n.t === 'num') return String(n.v);
    return String(n.v);
  }

  function renderModDetail(id) {
    const keys = [];
    const rows = [];
    for (const p of state.players) {
      let m = null;
      try { m = PIPE.readMods(p).find(x => x.id === id); } catch (e) { }
      if (!m) continue;
      const vals = {};
      m.fields.forEach(f => { if (keys.indexOf(f.key) < 0) keys.push(f.key); vals[f.key] = f.node; });
      rows.push({ p, vals });
      if (rows.length >= 300) break;
    }
    const fl = FIELD_LABEL[id] || {};
    let html = '<div class="sect" style="padding:16px 16px 8px">' + esc(modLabel(id)) +
      ' · 显示前 ' + rows.length + ' 个玩家</div><div style="padding:0 16px 24px"><table><thead><tr>' +
      '<th>昵称</th><th>UID</th>' + keys.map(k => '<th>' + esc(fl[k] || k) + '</th>').join('') +
      '</tr></thead><tbody>';
    for (const r of rows) {
      const d = r.p._d || (r.p._d = PIPE.readPlayer(r.p));
      html += '<tr><td>' + esc(d.nick || '—') + '</td><td class="mono">' + esc(d.uid) + '</td>' +
        keys.map(k => '<td>' + esc(modVal(r.vals[k])) + '</td>').join('') + '</tr>';
    }
    html += '</tbody></table></div>';
    const box = $('moddetail');
    box.innerHTML = html;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- 世界设置
  const GAME_TYPE = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观（旧）', 5: '默认', 6: '旁观' };
  const DIFFICULTY = { 0: '和平', 1: '简单', 2: '普通', 3: '困难' };

  let wSub = 'info';

  function renderWorld() {
    if (!state) return;
    const ld = state.levelDat;
    const box = $('worldbody');
    const scroller = $('worldscroll');
    box.innerHTML = '';
    document.querySelectorAll('.wsub button').forEach(b => {
      b.classList.toggle('on', b.dataset.w === wSub);
      b.onclick = () => { wSub = b.dataset.w; renderWorld(); if (scroller) scroller.scrollTop = 0; };
    });
    if (!ld) {
      box.appendChild(el('div', 'wnote', '这个存档里没有 level.dat（有些导出包只含 db 目录，世界设置读不到）'));
      return;
    }
    const r = ld.parsed.root;
    const touch = () => { ld.dirty = true; markDirty(null); };
    const lb = (label, tip) => '<label>' + esc(label) + (tip ? '<i>' + esc(tip) + '</i>' : '') + '</label>';

    /* ---------------- 控件 ---------------- */
    const sw = (key, label, tip) => {
      const n = CORE.nbtGet(r, key); if (!n) return null;
      const w = el('div', 'row');
      w.innerHTML = lb(label, tip);
      const b = el('button', 'switch' + (n.v ? ' on' : ''), n.v ? '开' : '关');
      b.onclick = () => {
        const nx = b.textContent !== '开';
        b.textContent = nx ? '开' : '关';
        b.classList.toggle('on', nx);
        n.v = nx ? 1 : 0;
        touch();
      };
      w.appendChild(b);
      return w;
    };
    const num = (key, label, tip, opt) => {
      const n = CORE.nbtGet(r, key); if (!n) return null;
      const w = el('div', 'row');
      w.innerHTML = lb(label, tip);
      const i = el('input');
      i.type = 'number';
      i.value = n.v;
      if (opt && opt.step != null) i.step = opt.step;
      if (opt && opt.min != null) i.min = opt.min;
      if (opt && opt.max != null) i.max = opt.max;
      i.onchange = () => {
        const s = i.value.trim();
        if (n.t === 4) { if (!/^-?\d+$/.test(s)) { i.value = n.v; return; } n.v = s; }
        else if (n.t === 5 || n.t === 6) { const f = parseFloat(s); if (isNaN(f)) { i.value = n.v; return; } n.v = f; }
        else { const v = parseInt(s, 10); if (isNaN(v)) { i.value = n.v; return; } n.v = v; }
        touch();
      };
      w.appendChild(i);
      return w;
    };
    const txt = (key, label, tip) => {
      const n = CORE.nbtGet(r, key); if (!n) return null;
      const w = el('div', 'row');
      w.innerHTML = lb(label, tip);
      const i = el('input');
      i.type = 'text';
      i.value = n.v;
      i.onchange = () => { PIPE.setStr(n, i.value); touch(); };
      w.appendChild(i);
      return w;
    };
    const sel = (key, label, table, tip) => {
      const n = CORE.nbtGet(r, key); if (!n) return null;
      const w = el('div', 'row');
      w.innerHTML = lb(label, tip);
      const s = el('select');
      Object.keys(table).forEach(k => { const o = el('option', null, table[k]); o.value = k; s.appendChild(o); });
      if (!(String(n.v) in table)) { const o = el('option', null, '未知（' + n.v + '）'); o.value = String(n.v); s.appendChild(o); }
      s.value = String(n.v);
      s.onchange = () => { n.v = parseInt(s.value, 10); touch(); };
      w.appendChild(s);
      return w;
    };
    const card = (title, desc, rows) => {
      const list = (rows || []).filter(Boolean);
      if (!list.length) return null;
      const c = el('div', 'wcard');
      c.innerHTML = '<h3>' + esc(title) + '</h3>' + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '');
      const g = el('div', 'wgrid');
      list.forEach(x => g.appendChild(x));
      c.appendChild(g);
      return c;
    };
    const add = n => { if (n) box.appendChild(n); };

    /* ---------------- 世界信息 ---------------- */
    if (wSub === 'info') {
      add(card('世界', '', [
        txt('LevelName', '世界名称'),
        num('RandomSeed', '世界种子', '改种子不会改变已经生成的地形', { step: 1 }),
        num('Time', '世界时间', '单位 tick，6000 约等于正午', { step: 100 })
      ]));
      add(card('出生点', '', [
        num('SpawnX', '出生点 X', '东西方向'),
        num('SpawnY', '出生点 Y', '高度'),
        num('SpawnZ', '出生点 Z', '南北方向'),
        num('spawnradius', '出生半径', '0 表示自动寻找安全出生点', { min: 0 })
      ]));
      const g = (k) => { const n = CORE.nbtGet(r, k); return n ? String(n.v) : '—'; };
      const info = el('div', 'wnote');
      info.innerHTML = ld.file.name + ' · NBT 体 ' + ld.length + ' 字节 · 版本 ' + ld.version +
        ' · 顶层 ' + r.v.entries.length + ' 个键<br>' +
        'Generator <code>' + esc(g('Generator')) + '</code> · StorageVersion <code>' + esc(g('StorageVersion')) + '</code>' +
        ' · InventoryVersion <code>' + esc(g('InventoryVersion')) + '</code>' +
        ' · NetworkVersion <code>' + esc(g('NetworkVersion')) + '</code>' +
        ' · LastPlayed <code>' + esc(g('LastPlayed')) + '</code>';
      box.appendChild(info);
    }

    /* ---------------- 游戏玩法 ---------------- */
    if (wSub === 'play') {
      add(card('基础', '', [
        sel('GameType', '默认游戏模式', GAME_TYPE),
        sel('Difficulty', '难度', DIFFICULTY),
        sw('IsHardcore', '极限模式', '死亡后无法重生'),
        sw('ForceGameType', '强制游戏模式', '进服后不允许改模式'),
        sw('commandsEnabled', '允许作弊指令', '开启后游戏内可用 /gamemode 等命令'),
        sw('immutableWorld', '不可变世界', '玩家不能放置或破坏方块')
      ]));
      add(card('世界与地图', '', [
        num('serverChunkTickRange', '区块范围', '模拟距离，越大越吃服务端性能', { min: 1, max: 32 }),
        sw('bonusChestEnabled', '奖励箱', '新建世界时在出生点附近放一个奖励箱'),
        sw('startWithMapEnabled', '初始地图', '玩家出生时背包里有一张空地图'),
        sw('CenterMapsToOrigin', '地图以原点为中心', '关闭时以创建地图的位置为中心'),
        sw('showcoordinates', '显示坐标', '在屏幕上显示自己的坐标'),
        sw('showdaysplayed', '显示游戏天数', '在屏幕上显示经过的天数')
      ]));
      add(card('多人', '', [
        sw('LANBroadcast', '局域网广播', '让别人能在局域网列表里看到这个房间'),
        sw('MultiplayerGame', '多人游戏', '允许其他人通过网络加入这个世界'),
        sw('texturePacksRequired', '必须使用纹理包', '玩家必须接受服务器下发的资源包才能进'),
        sw('hasLockedBehaviorPack', '锁定行为包', '进入后无法使用行为包'),
        sw('hasLockedResourcePack', '锁定资源包', '进入后无法使用资源包'),
        sw('hasBeenLoadedInCreative', '曾以创造模式载入', '会禁用这个世界获得成就')
      ]));
    }

    /* ---------------- 游戏规则 ---------------- */
    if (wSub === 'rules') {
      box.appendChild((() => {
        const n = el('div', 'wnote');
        n.innerHTML = '这些规则全部平铺在 level.dat 顶层，和游戏内 <code>/gamerule</code> 是同一批值。改了之后进游戏会立即生效。';
        return n;
      })());
      add(card('命令与作弊', '', [
        sw('commandsEnabled', '启用作弊'),
        sw('commandblocksenabled', '启用命令方块'),
        sw('commandblockoutput', '命令方块输出', '命令方块执行时是否把结果广播到聊天栏'),
        sw('sendcommandfeedback', '发送命令反馈', '玩家执行命令后的反馈是否显示'),
        num('maxcommandchainlength', '命令链最大长度', '连锁命令方块一次最多执行多少个', { min: 1 }),
        num('functioncommandlimit', '函数命令上限', '', { min: 1 })
      ]));
      add(card('掉落与伤害', '', [
        sw('doentitydrops', '实体掉落', '生物死亡时是否掉落物品'),
        sw('domobloot', '生物战利品', '生物死亡时是否掉落战利品'),
        sw('dotiledrops', '方块掉落', '方块被破坏时是否掉落物品'),
        sw('tntexplosiondropdecay', 'TNT 掉落衰减', '关闭时 TNT 炸掉的方块必定掉落'),
        sw('drowningdamage', '溺水伤害', '玩家是否受到溺水伤害'),
        sw('falldamage', '摔落伤害', '玩家是否受到摔落伤害'),
        sw('firedamage', '火焰伤害', '玩家是否受到火焰伤害'),
        sw('freezedamage', '冰冻伤害', '玩家是否受到冰冻伤害')
      ]));
      add(card('世界机制', '', [
        sw('dodaylightcycle', '昼夜循环', '关闭后太阳不再起落'),
        sw('doweathercycle', '天气更替', '关闭后天气不再变化'),
        sw('dofiretick', '火焰蔓延', '火焰能否自然蔓延和熄灭'),
        sw('domobspawning', '生物生成', '是否自然生成生物'),
        sw('mobgriefing', '生物破坏', '生物能否破坏方块（苦力怕爆炸、末影人搬方块等）'),
        sw('tntexplodes', 'TNT 爆炸', '关闭后 TNT 放置了也不炸'),
        sw('respawnblocksexplode', '重生方块爆炸', '床在下界、重生锚在主世界是否爆炸'),
        sw('projectilescanbreakblocks', '弹射物破坏方块', '箭矢等能否打掉紫颂果等方块'),
        sw('naturalregeneration', '自然生命恢复', '饥饿值满时是否自动回血'),
        sw('doinsomnia', '失眠', '是否生成幻翼'),
        num('randomtickspeed', '随机刻速度', '0 停止随机刻', { min: 0, max: 4096 })
      ]));
      add(card('玩家', '', [
        sw('keepinventory', '保留物品栏', '死亡后不掉落物品'),
        sw('pvp', '玩家对战', '玩家之间能否互相造成伤害'),
        sw('doimmediaterespawn', '立即重生', '死亡后跳过重生界面直接复活'),
        sw('recipesunlock', '解锁配方', '玩家是否自动解锁合成配方'),
        num('playerssleepingpercentage', '睡觉玩家百分比', '需要多少比例的玩家睡觉才跳过夜晚', { min: 0, max: 100 }),
        sw('showbordereffect', '显示边界效果', '靠近世界边界时的红色警告效果')
      ]));
      add(card('提示与显示', '', [
        sw('showdeathmessages', '显示死亡消息', '有人死亡时是否在聊天栏提示'),
        sw('showtags', '显示标签', '是否在玩家名字上方显示标签'),
        sw('showrecipemessages', '显示配方消息', '新解锁配方时是否提示'),
        sw('showcoordinates', '显示坐标'),
        sw('showdaysplayed', '显示游戏天数'),
        sw('dolimitedcrafting', '限制合成', '玩家只能合成已解锁的配方'),
        sw('isSingleUseWorld', '一次性世界', '世界只允许使用一次')
      ]));
    }

    /* ---------------- 教育版 ---------------- */
    if (wSub === 'edu') {
      const hasEdu = CORE.nbtGet(r, 'educationFeaturesEnabled');
      if (!hasEdu) {
        const n = el('div', 'wnote');
        n.innerHTML = '<b>这个存档里没有 educationFeaturesEnabled</b>，多半不是教育版世界。' +
          '在普通基岩版/网易版存档里强行加这个键，客户端不认，等于没写。';
        box.appendChild(n);
      }
      add(card('教育版功能', '开启后客户端会显示化学元素、元素构造器、代码构建器等教育版内容。前提是客户端本身支持教育版。', [
        sw('educationFeaturesEnabled', '启用教育版功能'),
        num('eduOffer', '教育优惠', '', { min: 0, max: 1 })
      ]));
      add(card('编辑器来源', '由 Minecraft 教育版「代码构建器 / 编辑模式」创建或导出时会留下这两个标记。', [
        sw('isCreatedInEditor', '在编辑器中创建'),
        sw('isExportedFromEditor', '从编辑器导出')
      ]));
      add(card('课堂限制', '', [
        sw('immutableWorld', '不可变世界', '玩家不能放置或破坏方块，课堂演示用')
      ]));

      const wp = CORE.nbtGet(r, 'world_policies');
      const c = el('div', 'wcard');
      c.innerHTML = '<h3>世界策略 world_policies</h3><div class="desc">教育版课堂策略，当前 ' +
        (wp && wp.v.entries ? wp.v.entries.length : 0) + ' 条。</div>';
      if (wp && wp.v.entries && wp.v.entries.length) {
        const g = el('div', 'wgrid');
        for (const [k, v] of wp.v.entries) {
          const w = el('div', 'row');
          w.innerHTML = lb(k, null);
          const i = el('input');
          i.type = 'text';
          i.value = v.v;
          i.onchange = () => {
            if (v.t === 1) v.v = (i.value === '1' || /^true$/i.test(i.value)) ? 1 : 0;
            else if (v.t === 8) { v.v = i.value; v.b = null; }
            else { const x = parseInt(i.value, 10); if (!isNaN(x)) v.v = x; }
            touch();
          };
          w.appendChild(i);
          g.appendChild(w);
        }
        c.appendChild(g);
      } else {
        c.appendChild(el('div', 'wnote', '当前没有世界策略。这个键存在但为空，通常是没在课堂模式下配过。'));
      }
      box.appendChild(c);
    }

    /* ---------------- 超平坦世界 ---------------- */
    if (wSub === 'flat') {
      const gen = CORE.nbtGet(r, 'Generator');
      const isFlat = gen && gen.v === 2;
      const n0 = el('div', 'wnote');
      n0.innerHTML = 'Generator = <code>' + (gen ? gen.v : '?') + '</code>' +
        (isFlat ? '，当前是超平坦世界。' : '，<b>当前不是超平坦世界</b>，改了下面的层也不会生效。');
      box.appendChild(n0);
      const fw = CORE.nbtGet(r, 'FlatWorldLayers');
      if (!fw) { box.appendChild(el('div', 'wnote', '这个存档没有 FlatWorldLayers 节点。')); return; }
      let j = null;
      try { j = JSON.parse(fw.v); } catch (e) { j = null; }
      if (!j || !Array.isArray(j.block_layers)) {
        box.appendChild(el('div', 'wnote', 'FlatWorldLayers 不是预期的 JSON 结构，这里不敢改。原始值：' + String(fw.v).slice(0, 200)));
        return;
      }
      const layers = j.block_layers;
      const c = el('div', 'wcard');
      let total = 0;
      layers.forEach(l => { total += (l.count || 0); });
      c.innerHTML = '<h3>层</h3><div class="desc">从下往上排列，第一层在最底下。当前总高度 ' + total + ' 层。</div>';
      const list = el('div');
      const repaint = () => {
        list.innerHTML = '';
        layers.forEach((l, idx) => {
          const row = el('div', 'lvrow');
          const badge = el('span', 'lvt', 'Y' + (layers.slice(0, idx).reduce((a, x) => a + (x.count || 0), 0)));
          const idIn = el('input');
          idIn.type = 'text';
          idIn.value = l.block_name || '';
          idIn.onchange = () => { l.block_name = idIn.value.trim() || l.block_name; saveFlat(); };
          const cnt = el('input');
          cnt.type = 'number';
          cnt.min = 1;
          cnt.value = l.count || 1;
          cnt.style.maxWidth = '90px';
          cnt.onchange = () => { const v = parseInt(cnt.value, 10); if (v > 0) l.count = v; saveFlat(); repaint(); };
          const del = el('button', 'sbdel', '删');
          del.onclick = () => { layers.splice(idx, 1); saveFlat(); repaint(); };
          row.appendChild(badge);
          row.appendChild(idIn);
          row.appendChild(cnt);
          row.appendChild(del);
          list.appendChild(row);
        });
        if (!layers.length) list.appendChild(el('div', 'wnote', '一层都不剩了。至少留一层基岩，否则进游戏是虚空。'));
      };
      const saveFlat = () => {
        j.block_layers = layers;
        PIPE.setStr(fw, JSON.stringify(j));
        touch();
      };
      repaint();
      c.appendChild(list);
      const bar = el('div', '');
      bar.style.marginTop = '10px';
      const addBtn = el('button', 'mini', '＋ 加一层');
      addBtn.onclick = () => { layers.push({ block_name: 'minecraft:stone', count: 1 }); saveFlat(); repaint(); };
      bar.appendChild(addBtn);
      c.appendChild(bar);
      box.appendChild(c);

      const g2 = el('div', 'wcard');
      g2.innerHTML = '<h3>其他字段</h3><div class="desc">这些都存在 FlatWorldLayers 的 JSON 里，改完一起保存。</div>';
      const gg = el('div', 'wgrid');
      const simple = (k, label, tip) => {
        if (!(k in j)) return;
        const w = el('div', 'row');
        w.innerHTML = lb(label, tip);
        const i = el('input');
        i.type = (typeof j[k] === 'number') ? 'number' : 'text';
        i.value = j[k] === null ? '' : j[k];
        i.onchange = () => {
          if (typeof j[k] === 'number') { const v = parseInt(i.value, 10); if (!isNaN(v)) j[k] = v; }
          else j[k] = i.value;
          saveFlat();
        };
        w.appendChild(i);
        gg.appendChild(w);
      };
      simple('biome_id', '生物群系 ID', '决定超平坦世界的地表颜色、天空色调等');
      simple('encoding_version', '编码版本', '别改，改了游戏可能读不了');
      simple('world_version', '世界版本', '例如 version.post_1_18');
      g2.appendChild(gg);
      box.appendChild(g2);
    }

    /* ---------------- 实验性功能 ---------------- */
    if (wSub === 'exp') {
      const ex = CORE.nbtGet(r, 'experiments');
      const cnt = (ex && ex.v.entries) ? ex.v.entries.length : 0;
      const n0 = el('div', 'wnote');
      n0.innerHTML = '实验性功能是在<b>创建世界那一刻</b>勾选的。level.dat 里这里只有若干标记位，' +
        '不是「打开开关就启用」——在这里凭空加一个值，客户端不认，还可能让存档读不进去。' +
        '<br>当前这个存档有 ' + cnt + ' 个标记。';
      box.appendChild(n0);
      if (!ex || !cnt) {
        box.appendChild(el('div', 'wnote', '没有 experiments 节点，说明从没开过实验性功能。'));
        return;
      }
      const g = el('div', 'wcard');
      g.innerHTML = '<h3>标记位</h3><div class="desc">原样列出，改之前先备份。</div>';
      const gg = el('div', 'wgrid');
      for (const [k, v] of ex.v.entries) {
        const w = el('div', 'row');
        w.innerHTML = lb(k, null);
        if (v.t === 1) {
          const b = el('button', 'switch' + (v.v ? ' on' : ''), v.v ? '开' : '关');
          b.onclick = () => {
            const nx = b.textContent !== '开';
            b.textContent = nx ? '开' : '关';
            b.classList.toggle('on', nx);
            v.v = nx ? 1 : 0; touch();
          };
          w.appendChild(b);
        } else {
          const i = el('input');
          i.type = 'text';
          i.value = v.v;
          i.onchange = () => { v.v = i.value; touch(); };
          w.appendChild(i);
        }
        gg.appendChild(w);
      }
      g.appendChild(gg);
      box.appendChild(g);
    }

    /* ---------------- 能力 ---------------- */
    if (wSub === 'ability') {
      const ab = CORE.nbtGet(r, 'abilities');
      if (!ab || !ab.v.entries) {
        box.appendChild(el('div', 'wnote', '这个存档没有 abilities 节点。'));
        return;
      }
      const one = (key, label, tip) => {
        const n = CORE.nbtGet(ab, key); if (!n) return null;
        const w = el('div', 'row');
        w.innerHTML = lb(label, tip);
        if (n.t === 1) {
          const b = el('button', 'switch' + (n.v ? ' on' : ''), n.v ? '开' : '关');
          b.onclick = () => {
            const nx = b.textContent !== '开';
            b.textContent = nx ? '开' : '关';
            b.classList.toggle('on', nx);
            n.v = nx ? 1 : 0; touch();
          };
          w.appendChild(b);
        } else {
          const i = el('input');
          i.type = 'number';
          i.step = '0.01';
          i.value = n.v;
          i.onchange = () => { const f = parseFloat(i.value); if (isNaN(f)) { i.value = n.v; return; } n.v = f; touch(); };
          w.appendChild(i);
        }
        return w;
      };
      add(card('默认玩家能力', '这些是世界的默认能力，影响所有玩家，不是某个人的。', [
        one('build', '放置方块'),
        one('mine', '挖掘'),
        one('doorsandswitches', '使用红石', '门、开关、按钮等'),
        one('opencontainers', '打开容器', '箱子、熔炉、工作台等'),
        one('attackplayers', '攻击玩家'),
        one('attackmobs', '攻击生物')
      ]));
      add(card('权限', '', [
        one('op', '管理员', '拥有管理员命令'),
        one('teleport', '传送'),
        one('invulnerable', '无敌', '免疫伤害'),
        one('instabuild', '瞬间建造', '瞬间破坏与放置方块'),
        one('mayfly', '允许飞行')
      ]));
      add(card('移动速度', '', [
        one('walkSpeed', '行走速度', '默认 0.1'),
        one('flySpeed', '飞行速度', '默认 0.05'),
        one('verticalFlySpeed', '垂直飞行速度', '默认 1'),
        one('flying', '正在飞行', ''),
        one('lightning', '闪电', '')
      ]));
    }

    /* ---------------- 高级 ---------------- */
    if (wSub === 'raw') {
      const note = el('div', 'wnote');
      note.innerHTML = 'level.dat 全部 <b>' + r.v.entries.length + '</b> 个顶层键。数字和字符串可以直接改，' +
        'Compound / List 这类结构这里只读。<br>改之前请确认你知道这个键是干什么的 —— 改错可能导致世界读不进去。';
      box.appendChild(note);
      const TNAME = { 1: 'B', 2: 'S', 3: 'I', 4: 'L', 5: 'F', 6: 'D', 7: 'BA', 8: 'S', 9: 'L', 10: 'C', 11: 'IA', 12: 'LA' };
      const holder = el('div');
      for (const [k, v] of r.v.entries) {
        const row = el('div', 'lvrow');
        const kk = el('span', 'lvk', k);
        kk.title = k;
        const tt = el('span', 'lvt', TNAME[v.t] || '?');
        row.appendChild(kk);
        row.appendChild(tt);
        const simple = v.t === 1 || v.t === 2 || v.t === 3 || v.t === 4 || v.t === 5 || v.t === 6 || v.t === 8;
        if (simple) {
          const i = el('input');
          i.type = (v.t === 5 || v.t === 6) ? 'number' : 'text';
          i.value = v.v;
          i.onchange = () => {
            const s = i.value;
            if (v.t === 8) { PIPE.setStr(v, s); touch(); return; }
            if (v.t === 4) { if (!/^-?\d+$/.test(s.trim())) { i.value = v.v; return; } v.v = s.trim(); touch(); return; }
            if (v.t === 5 || v.t === 6) { const f = parseFloat(s); if (isNaN(f)) { i.value = v.v; return; } v.v = f; touch(); return; }
            const x = parseInt(s, 10); if (isNaN(x)) { i.value = v.v; return; } v.v = x; touch();
          };
          row.appendChild(i);
        } else {
          row.classList.add('ro');
          let prev = '';
          if (v.t === 10) prev = v.v.entries.length + ' 项';
          else if (v.t === 9) prev = v.v.items.length + ' 项';
          else if (v.t === 7) prev = v.v.length + ' 字节';
          else if (v.t === 11 || v.t === 12) prev = v.v.length + ' 项';
          const rr = el('span', 'lvr', prev);
          row.appendChild(rr);
        }
        holder.appendChild(row);
      }
      box.appendChild(holder);
    }
  }

})();
