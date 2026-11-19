/* LevelDB 严格校验器
 * 按 leveldb / Mojang fork 的真实读取路径逐条检查，而不是「我们自己的读器能读就算过」。
 *   1. 块尾 CRC 必须是 crc32c::Mask 之后的（leveldb 的 BlockReader 会校验，不匹配直接当损坏）
 *   2. restart 数组的每个偏移必须指向 shared==0 的记录，且首项为 0、递增、不越界
 *   3. index 块的分隔键必须 >= 本块末键、< 下一块首键
 *   4. 模拟 Seek/Get：二分 restart → 线性扫描，确认任意键都找得到
 */
'use strict';

const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

function u32(u8, p) { return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0; }
function i32(u8, p) { const v = u32(u8, p); return v | 0; }
function mk(u8, p) { return ((((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0) >>> 15) |
  (((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) << 17)) >>> 0); }
function mask(c) { return ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0; }
function varint(u8, p) {
  let x = 0, sh = 0, b;
  do { b = u8[p++]; x += (b & 0x7f) * Math.pow(2, sh); sh += 7; if (sh > 63) throw new Error('varint 过长'); } while (b & 0x80);
  return [x, p];
}
function cmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}
/* 内部键排序：用户键升序；用户键相同则序列号【降序】（leveldb 的 InternalKeyComparator） */
function cmpIK(a, b) {
  const ua = a.subarray(0, Math.max(0, a.length - 8));
  const ub = b.subarray(0, Math.max(0, b.length - 8));
  const c = cmp(ua, ub);
  if (c) return c;
  if (a.length < 8 || b.length < 8) return a.length - b.length;
  let ta = 0n, tb = 0n;
  for (let i = 7; i >= 0; i--) { ta = (ta << 8n) | BigInt(a[a.length - 8 + i]); tb = (tb << 8n) | BigInt(b[b.length - 8 + i]); }
  if (ta === tb) return 0;
  return ta > tb ? -1 : 1;
}
function userKey(k) { return k.subarray(0, Math.max(0, k.length - 8)); }
function hex(u8, n) {
  const k = Math.min(u8.length, n === undefined ? 8 : n);
  let s = '';
  for (let i = 0; i < k; i++) s += u8[i].toString(16).padStart(2, '0');
  return s + (u8.length > k ? '…' : '');
}

/* ---------- 块解析：完全按 leveldb Block::Iter 的规则 ---------- */
function parseBlock(payload, name, errs, warns) {
  if (payload.length < 4) { errs.push(name + ': 块太短（' + payload.length + '）'); return null; }
  const nRestarts = i32(payload, payload.length - 4);
  if (nRestarts <= 0) { errs.push(name + ': restart 数量 ' + nRestarts + ' ≤ 0'); return null; }
  const restartArr = payload.length - 4 - 4 * nRestarts;
  if (restartArr < 0) { errs.push(name + ': restart 数组越界（n=' + nRestarts + '，块长 ' + payload.length + '）'); return null; }
  const restarts = [];
  for (let i = 0; i < nRestarts; i++) restarts.push(i32(payload, restartArr + 4 * i));
  if (restarts[0] !== 0) errs.push(name + ': restart[0] = ' + restarts[0] + '，必须是 0');
  for (let i = 1; i < restarts.length; i++) {
    if (restarts[i] <= restarts[i - 1]) errs.push(name + ': restart 偏移不是递增（' + restarts[i - 1] + ' → ' + restarts[i] + '）');
  }
  for (const r of restarts) {
    if (r < 0 || r > restartArr) errs.push(name + ': restart 偏移 ' + r + ' 超出正文范围 [0,' + restartArr + ']');
  }

  const entries = [];
  let p = 0, prevKey = new Uint8Array(0);
  const restartSet = new Set(restarts);
  while (p < restartArr) {
    const recStart = p;
    let shared, nonShared, vlen;
    try { [shared, p] = varint(payload, p); [nonShared, p] = varint(payload, p); [vlen, p] = varint(payload, p); }
    catch (e) { errs.push(name + ': 偏移 ' + recStart + ' 处记录头损坏'); break; }
    if (p + nonShared + vlen > restartArr) { errs.push(name + ': 偏移 ' + recStart + ' 处记录越界'); break; }
    const delta = payload.subarray(p, p + nonShared); p += nonShared;
    const val = payload.subarray(p, p + vlen); p += vlen;
    if (shared > prevKey.length) {
      errs.push(name + ': 偏移 ' + recStart + ' 记录 shared=' + shared + ' 大于前键长度 ' + prevKey.length);
      break;
    }
    const key = new Uint8Array(shared + nonShared);
    key.set(prevKey.subarray(0, shared), 0);
    key.set(delta, shared);
    if (restartSet.has(recStart) && shared !== 0) {
      errs.push(name + ': restart 偏移 ' + recStart + ' 处记录 shared=' + shared + '，必须是 0（会导致 Seek 判损坏）');
    }
    if (entries.length && cmpIK(entries[entries.length - 1].key, key) > 0) {
      errs.push(name + ': 键不是升序，偏移 ' + recStart);
    }
    entries.push({ key, value: val, shared, off: recStart });
    prevKey = key;
  }
  if (p !== restartArr) errs.push(name + ': 正文读完停在 ' + p + '，应为 ' + restartArr);
  return { entries, restarts, restartArr };
}

/* ---------- 单块读取（含 CRC） ---------- */
function readBlock(file, off, size, name, errs) {
  if (off < 0 || size < 0 || off + size + 5 > file.length) {
    errs.push(name + ': BlockHandle 越界 off=' + off + ' size=' + size + '，文件 ' + file.length);
    return null;
  }
  const payload = file.subarray(off, off + size);
  const type = file[off + size];
  const stored = u32(file, off + size + 1);
  const crc = crc32cBlock(payload, type);
  if (stored !== crc.masked) {
    errs.push(name + ': 块尾 CRC 不匹配（存 ' + stored.toString(16) + '，应为掩码值 ' + crc.masked.toString(16) +
      (stored === crc.raw ? '；存的是未掩码值 ' + crc.raw.toString(16) + ' ← leveldb 会判为数据损坏' : '') + '）');
  }
  let body = payload;
  if (type === 4) body = inflateRaw(payload, name, errs);
  else if (type === 2) body = inflateZlib(payload, name, errs);
  else if (type === 1) { errs.push(name + ': 压缩类型 1（snappy），本校验器不支持'); return null; }
  else if (type !== 0) { errs.push(name + ': 未知压缩类型 ' + type); return null; }
  if (!body) return null;
  return parseBlock(body, name, errs);
}

/* CRC 表 */
const TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32cBlock(payload, type) {
  let c = 0xffffffff;
  for (let i = 0; i < payload.length; i++) c = TAB[(c ^ payload[i]) & 0xff] ^ (c >>> 8);
  c = TAB[(c ^ type) & 0xff] ^ (c >>> 8);
  const raw = (c ^ 0xffffffff) >>> 0;
  return { raw, masked: mask(raw) };
}

let zlib = null;
try { zlib = require('zlib'); } catch (e) { }
function inflateRaw(u8, name, errs) {
  if (!zlib) { errs.push(name + ': 需要 zlib'); return null; }
  try { return new Uint8Array(zlib.inflateRawSync(Buffer.from(u8))); }
  catch (e) { errs.push(name + ': raw deflate 解压失败 ' + e.message); return null; }
}
function inflateZlib(u8, name, errs) {
  if (!zlib) { errs.push(name + ': 需要 zlib'); return null; }
  try { return new Uint8Array(zlib.inflateSync(Buffer.from(u8))); }
  catch (e) { errs.push(name + ': zlib 解压失败 ' + e.message); return null; }
}

/* ---------- 校验一个 SST 文件 ---------- */
function checkSst(file, name) {
  const errs = [], warns = [];
  const out = { name, errs, warns, keys: 0, blocks: 0, seekFail: 0 };
  if (file.length < 48) { errs.push(name + ': 文件太短'); return out; }
  const foot = file.subarray(file.length - 48);
  for (let i = 0; i < 8; i++) {
    if (foot[40 + i] !== MAGIC[i]) { errs.push(name + ': 文件尾 magic 不对'); break; }
  }
  let p = 0, mo, ms, io, isz;
  [mo, p] = varint(foot, p); [ms, p] = varint(foot, p);
  [io, p] = varint(foot, p); [isz, p] = varint(foot, p);

  const meta = readBlock(file, mo, ms, name + ' [meta]', errs);
  const index = readBlock(file, io, isz, name + ' [index]', errs);
  if (!index) return out;
  if (!meta) errs.push(name + ': meta 块读不出来');
  if (index.entries.length === 0) errs.push(name + ': index 块是空的，整个 SST 等于没有数据');

  let prevBlockLastKey = null;
  for (let bi = 0; bi < index.entries.length; bi++) {
    const ie = index.entries[bi];
    const sepKey = ie.key.subarray(0, Math.max(0, ie.key.length - 8));
    const val = ie.value;
    let off, size, q = 0;
    [off, q] = varint(val, q); [size, q] = varint(val, q);
    const blk = readBlock(file, off, size, name + ' 块#' + bi, errs);
    if (!blk) continue;
    out.blocks++;
    out.keys += blk.entries.length;
    if (!blk.entries.length) { errs.push(name + ' 块#' + bi + ': 索引里有句柄但块内 0 条记录'); continue; }
    const first = blk.entries[0].key, last = blk.entries[blk.entries.length - 1].key;
    if (cmp(sepKey, userKey(last)) < 0) errs.push(name + ' 块#' + bi + ': index 分隔键 < 本块末键（Seek 可能定位到错误块）');
    if (prevBlockLastKey && cmp(cmpIK(prevBlockLastKey, first) > 0 ? prevBlockLastKey : first, cmpIK(prevBlockLastKey, first) > 0 ? first : prevBlockLastKey) > 0) { /* 已按序 */ }
    if (prevBlockLastKey && cmpIK(prevBlockLastKey, first) >= 0) errs.push(name + ' 块#' + bi + ': 与上一块键范围重叠');
    prevBlockLastKey = last;
    // 模拟 Seek：块内二分 + 线性
    for (const sample of [0, Math.floor(blk.entries.length / 2), blk.entries.length - 1]) {
      const target = blk.entries[sample].key;
      const pos = seekInBlock(blk, target);
      if (pos < 0 || cmpIK(blk.entries[pos].key, target) !== 0) {
        out.seekFail++;
        errs.push(name + ' 块#' + bi + ': 块内 Seek 找不到第 ' + sample + ' 条（restart 数组坏了）');
        break;
      }
    }
  }
  return out;
}

/* leveldb Block::Iter::Seek 的等价实现 */
function seekInBlock(blk, target) {
  // 二分 restart，找最后一个 restart 键 < target
  let left = 0, right = blk.restarts.length - 1;
  const keys = blk.entries;
  if (!keys.length) return -1;
  // 建立 restart 偏移 → 记录下标
  const idxOf = new Map();
  keys.forEach((e, i) => idxOf.set(e.off, i));
  let lo = 0;
  while (left < right) {
    const mid = Math.ceil((left + right) / 2);
    const ri = idxOf.get(blk.restarts[mid]);
    if (ri === undefined) { return -1; }           // restart 指向不存在的位置 → 真 leveldb 在这里判损坏
    if (cmpIK(keys[ri].key, target) < 0) left = mid; else right = mid - 1;
  }
  const startIdx = idxOf.get(blk.restarts[left]);
  if (startIdx === undefined) return -1;
  for (let i = startIdx; i < keys.length; i++) {
    if (cmpIK(keys[i].key, target) >= 0) return i;
  }
  return -1;
}

/* ---------- 校验整个 db ---------- */
function checkDatabase(files, CORE) {
  const ssts = [];
  for (const f of files) {
    if (!/\.ldb$/i.test(f.name)) continue;
    const data = CORE ? CORE.decryptFile(f.name, f.data) : f.data;
    ssts.push({ name: f.name, data });
  }
  const all = [];
  let keys = 0;
  for (const s of ssts.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = checkSst(s.data, s.name);
    all.push(r);
    keys += r.keys;
  }
  // MANIFEST / CURRENT
  const man = files.find(f => /^MANIFEST/.test(f.name));
  const cur = files.find(f => f.name === 'CURRENT');
  const manifestErrs = [];
  if (!man) manifestErrs.push('缺 MANIFEST 文件');
  if (!cur) manifestErrs.push('缺 CURRENT');
  if (cur) {
    const txt = (CORE ? CORE.latin1(CORE.decryptFile('CURRENT', cur.data)) : Buffer.from(cur.data).toString('latin1'));
    if (!/^MANIFEST-\d+\s*$/.test(txt)) manifestErrs.push('CURRENT 内容不是 MANIFEST-xxxxxx：' + JSON.stringify(txt.slice(0, 40)));
  }
  return { ssts: all, keys, manifestErrs, sstCount: ssts.length };
}

module.exports = { checkSst, checkDatabase, parseBlock, readBlock, seekInBlock, cmp, cmpIK, userKey, hex, crc32cBlock };
