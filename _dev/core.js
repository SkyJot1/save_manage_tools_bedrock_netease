/* 快建存档编辑器 · 内核（浏览器 / node 通用）
 * 模块：crc、varint、网易加解密、NBT、CBOR、LevelDB 读、LevelDB 写、ZIP 读写
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CORE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ 基础工具
  const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function utf8Encode(s) {
    if (te) return te.encode(s);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(u8) {
    if (td) return td.decode(u8);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /* 有些字段（scriptData、internalComponents.StorageKey）在 NBT 里标的是 String，
   * 装的却是二进制（CBOR、序列化结构）。硬解成 UTF-8 会变成一屏 U+FFFD，
   * 那既不是数据坏了也不是解码错了，只是它本来就不是文本。
   * 这里只做判断，不动原始字节 —— 写回时仍然用 node.b，逐字节不变。 */
  function looksBinary(s) {
    if (!s) return false;
    let bad = 0, ctrl = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0xfffd) bad++;
      else if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) ctrl++;
    }
    if (bad) return true;
    // 少量换行/制表符是正常文本；控制字符占比超两成基本就是二进制
    return ctrl > 0 && ctrl * 5 >= s.length;
  }
  function concat(list) {
    let n = 0;
    for (const a of list) n += a.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const a of list) { out.set(a, p); p += a.length; }
    return out;
  }
  function eqBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function indexOfBytes(hay, needle, from) {
    const n = needle.length;
    if (!n) return -1;
    const first = needle[0];
    for (let i = from || 0; i <= hay.length - n; i++) {
      if (hay[i] !== first) continue;
      let ok = true;
      for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }
  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  // ------------------------------------------------------------ 校验和
  const CRC32C_T = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32c(u8, end) {
    let crc = 0xffffffff;
    const n = end === undefined ? u8.length : end;
    for (let i = 0; i < n; i++) crc = CRC32C_T[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  const CRC32_T = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let crc = 0xffffffff;
    for (let i = 0; i < u8.length; i++) crc = CRC32_T[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  const maskCrc = c => ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0;

  // ------------------------------------------------------------ varint
  function readVarint(u8, p) {
    let x = 0, shift = 0, b;
    do { b = u8[p++]; x += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    return [x, p];
  }
  function writeVarint(out, x) {
    while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
    out.push(x);
  }
  function varintBytes(x) { const o = []; writeVarint(o, x); return new Uint8Array(o); }

  // ------------------------------------------------------------ 网易加解密
  const XOR_KEY = asciiBytes('98518832');
  const NETEASE_PREFIX = new Uint8Array([0xb9, 0x25, 0x05, 0x30]);
  const LDB_MAGIC = new Uint8Array([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

  function xorBytes(u8) {
    const out = new Uint8Array(u8.length);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] ^ XOR_KEY[i & 7];
    return out;
  }
  function endsWith(u8, tail) {
    if (u8.length < tail.length) return false;
    for (let i = 0; i < tail.length; i++) if (u8[u8.length - tail.length + i] !== tail[i]) return false;
    return true;
  }
  function includesAscii(u8, s) { return indexOfBytes(u8, asciiBytes(s), 0) >= 0; }

  function isEncryptedName(name) {
    return /\.ldb$/i.test(name) || /^MANIFEST/i.test(name) || name === 'CURRENT';
  }
  function isStandard(name, u8) {
    if (/\.ldb$/i.test(name)) return endsWith(u8, LDB_MAGIC);
    if (/^MANIFEST/i.test(name)) return includesAscii(u8, 'leveldb.BytewiseComparator');
    if (name === 'CURRENT') return /^MANIFEST-\d+\s*$/.test(latin1(u8));
    return false;
  }
  function decryptFile(name, u8) {
    if (!isEncryptedName(name)) return u8;
    if (isStandard(name, u8)) return u8;
    const dec = xorBytes(u8);
    if (dec.length > 4 && eqBytes(dec.subarray(0, 4), NETEASE_PREFIX) && isStandard(name, dec.subarray(4))) {
      return dec.subarray(4);
    }
    if (isStandard(name, dec)) return dec;
    return u8;
  }
  function encryptFile(name, u8) {
    if (!isEncryptedName(name)) return u8;
    if (isStandard(name, u8)) return xorBytes(concat([NETEASE_PREFIX, u8]));
    if (isStandard(name, decryptFile(name, u8))) return u8;
    return u8;
  }

  // ------------------------------------------------------------ NBT
  const T = {
    End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
    ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12
  };
  const TYPE_NAME = ['End', 'Byte', 'Short', 'Int', 'Long', 'Float', 'Double',
    'ByteArray', 'String', 'List', 'Compound', 'IntArray', 'LongArray'];

  /* 长字符串规则（实测，两层都要处理）：
   *
   *   1. 普通字符串：长度 uint16
   *   2. 「长字符串」：长度 int32。本存档里有两处：
   *        scriptData
   *        internalComponents.EntityStorageKeyComponent.StorageKey
   *      两者内容都是二进制，里面本来就含非法 UTF-8 字节。
   *
   * 只看局部字节没法可靠区分（两种解读都能"勉强"读下去，只是树会错位），
   * 所以用两把尺子定案：能正好收到末尾 + 重新序列化后逐字节相同。
   * 对不上就换一组字段名再试，成功的那组记下来给下一条记录先用。 */
  let LEARNED_LONG = null;
  let FAST_HITS = 0;

  function nbtParse(buf, longNames) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const longs = longNames instanceof Set ? longNames : new Set(longNames || []);
    let p = 0;
    const censored = [];   // 记录所有字符串节点的名字（用于猜长字符串）

    const u1 = () => u8[p++];
    const u2 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
    const i4 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
    const str = (name) => {
      let n;
      const useLong = name !== null && longs.has(name);
      if (useLong) n = i4();
      else n = u2();
      if (n < 0 || p + n > u8.length) throw new Error('字符串越界');
      const raw = u8.subarray(p, p + n);
      p += n;
      if (name !== null) censored.push(name);
      const s = utf8Decode(raw);
      return { s, b: raw, bin: looksBinary(s) };
    };

    function payload(type, nameForString) {
      switch (type) {
        case T.Byte: { const v = dv.getInt8(p); p += 1; return { t: type, v }; }
        case T.Short: { const v = dv.getInt16(p, true); p += 2; return { t: type, v }; }
        case T.Int: { const v = i4(); return { t: type, v }; }
        case T.Long: { const v = dv.getBigInt64(p, true); p += 8; return { t: type, v: v.toString() }; }
        case T.Float: { const v = dv.getFloat32(p, true); p += 4; return { t: type, v }; }
        case T.Double: { const v = dv.getFloat64(p, true); p += 8; return { t: type, v }; }
        case T.String: {
          const r = str(nameForString);
          return { t: type, v: r.s, b: r.b, bin: r.bin };
        }
        case T.ByteArray: {
          const n = i4();
          if (n < 0 || p + n > u8.length) throw new Error('ByteArray 越界');
          const a = u8.subarray(p, p + n); p += n;
          return { t: type, v: a };
        }
        case T.IntArray: {
          const n = i4();
          if (n < 0 || p + 4 * n > u8.length) throw new Error('IntArray 越界');
          const a = new Array(n);
          for (let i = 0; i < n; i++) a[i] = i4();
          return { t: type, v: a };
        }
        case T.LongArray: {
          const n = i4();
          if (n < 0 || p + 8 * n > u8.length) throw new Error('LongArray 越界');
          const a = new Array(n);
          for (let i = 0; i < n; i++) { a[i] = dv.getBigInt64(p, true).toString(); p += 8; }
          return { t: type, v: a };
        }
        case T.List: {
          const el = u1();
          const n = i4();
          if (n < 0 || n > u8.length) throw new Error('List 长度异常');
          const items = new Array(n);
          for (let i = 0; i < n; i++) items[i] = payload(el, null);
          return { t: type, v: { el, items } };
        }
        case T.Compound: {
          const entries = [];
          for (;;) {
            if (p >= u8.length) throw new Error('Compound 未收尾');
            const tt = u1();
            if (tt === T.End) break;
            if (tt > 12) throw new Error('非法类型 ' + tt);
            const nm = str(null).s;
            entries.push([nm, payload(tt, nm)]);
          }
          return { t: type, v: { entries } };
        }
        default: throw new Error('未知 NBT 类型 ' + type);
      }
    }

    const type = u1();
    if (type !== T.Compound) throw new Error('根不是 Compound');
    const name = str(null).s;
    const root = payload(type, null);
    return { name, root, end: p, longNames: longs, censored };
  }

  /* 试一组 long 字段名，要求「正好收尾 + 原样写回」都成立 */
  function tryLong(u8, names) {
    let r;
    try { r = nbtParse(u8, names); } catch (e) { return null; }
    if (r.end !== u8.length) return null;
    let out;
    try { out = nbtWrite(r.root, r.name, r.longNames); } catch (e) { return null; }
    if (!eqBytes(out, u8)) return null;
    return r;
  }

  /** 自动判定哪些字段用 int32 长度；返回 {name, root, end, longNames} */
  function nbtParseAuto(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (LEARNED_LONG) {
      // 已学会的组合：只验收尾，每 200 条再做一次完整校验（逐字节比对）
      try {
        const r = nbtParse(u8, LEARNED_LONG);
        if (r.end === u8.length) {
          if ((FAST_HITS++ % 200) !== 0) return r;
          const full = tryLong(u8, LEARNED_LONG);
          if (full) return full;
        }
      } catch (e) { }
      const fast = tryLong(u8, LEARNED_LONG);
      if (fast) return fast;
    }
    const plain = tryLong(u8, []);
    if (plain) { LEARNED_LONG = new Set(); return plain; }

    let probe = null;
    try { probe = nbtParse(u8, []); } catch (e) { probe = null; }
    const cand = probe ? Array.from(new Set(probe.censored)) : [];

    for (const n of cand) {
      const r = tryLong(u8, [n]);
      if (r) { LEARNED_LONG = new Set([n]); return r; }
    }
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const r = tryLong(u8, [cand[i], cand[j]]);
        if (r) { LEARNED_LONG = new Set([cand[i], cand[j]]); return r; }
      }
    }
    for (const combo of [['scriptData'], ['StorageKey'], ['scriptData', 'StorageKey']]) {
      const r = tryLong(u8, combo);
      if (r) { LEARNED_LONG = new Set(combo); return r; }
    }
    const r = nbtParse(u8, []);
    r.partial = true;
    return r;
  }

  function nbtWrite(root, name, longNames) {
    const longs = longNames instanceof Set ? longNames : new Set(longNames || []);
    const out = [];
    function wstr(s, useLong, raw) {
      const b = raw || utf8Encode(s);
      if (useLong) out.push(new Uint8Array([b.length & 0xff, (b.length >> 8) & 0xff, (b.length >> 16) & 0xff, (b.length >>> 24) & 0xff]));
      else out.push(new Uint8Array([b.length & 0xff, (b.length >> 8) & 0xff]));
      out.push(b);
    }
    function payload(node, nameForString) {
      switch (node.t) {
        case T.Byte: out.push(new Uint8Array([node.v & 0xff])); break;
        case T.Short: { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, node.v, true); out.push(b); break; }
        case T.Int: { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, node.v, true); out.push(b); break; }
        case T.Long: { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(node.v), true); out.push(b); break; }
        case T.Float: { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, node.v, true); out.push(b); break; }
        case T.Double: { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, node.v, true); out.push(b); break; }
        case T.String: wstr(node.v, longs.has(nameForString), node.b); break;
        case T.ByteArray: {
          const n = new Uint8Array(4); new DataView(n.buffer).setInt32(0, node.v.length, true);
          out.push(n, node.v); break;
        }
        case T.IntArray: {
          const b = new Uint8Array(4 + node.v.length * 4);
          const dv = new DataView(b.buffer);
          dv.setInt32(0, node.v.length, true);
          node.v.forEach((x, i) => dv.setInt32(4 + i * 4, x, true));
          out.push(b); break;
        }
        case T.LongArray: {
          const b = new Uint8Array(4 + node.v.length * 8);
          const dv = new DataView(b.buffer);
          dv.setInt32(0, node.v.length, true);
          node.v.forEach((x, i) => dv.setBigInt64(4 + i * 8, BigInt(x), true));
          out.push(b); break;
        }
        case T.List: {
          const head = new Uint8Array(5);
          head[0] = node.v.el;
          new DataView(head.buffer).setInt32(1, node.v.items.length, true);
          out.push(head);
          for (const it of node.v.items) payload(it, null);
          break;
        }
        case T.Compound:
          for (const [k, v] of node.v.entries) {
            out.push(new Uint8Array([v.t]));
            wstr(k, false);
            payload(v, k);
          }
          out.push(new Uint8Array([0]));
          break;
        default: throw new Error('写不了类型 ' + node.t);
      }
    }
    out.push(new Uint8Array([root.t]));
    wstr(name || '', false);
    payload(root, null);
    return concat(out);
  }

  function nbtGet(node, path) {
    let cur = node;
    for (const k of String(path).split('.')) {
      if (!cur || cur.t !== T.Compound) return undefined;
      const e = cur.v.entries.find(x => x[0] === k);
      if (!e) return undefined;
      cur = e[1];
    }
    return cur;
  }
  function nbtSet(node, path, value) {
    const parts = String(path).split('.');
    let cur = node;
    for (let i = 0; i < parts.length - 1; i++) {
      const e = cur.v.entries.find(x => x[0] === parts[i]);
      if (!e || e[1].t !== T.Compound) return false;
      cur = e[1];
    }
    const e = cur.v.entries.find(x => x[0] === parts[parts.length - 1]);
    if (!e) return false;
    e[1] = value;
    return true;
  }
  function nbtNum(node) {
    if (!node) return undefined;
    if (typeof node.v === 'bigint') return Number(node.v);
    if (typeof node.v === 'string' && /^-?\d+$/.test(node.v) && node.t === T.Long) return Number(node.v);
    return node.v;
  }

  // ------------------------------------------------------------ CBOR（7stars 用）
  /* 这个存档里的字符串不是标准 CBOR 的 0x78/0x58，而是 0xc4 + 变长长度 + utf8。
   * 其余是标准 CBOR：0x00-0x17 整数、0x18/0x19 多字节整数、0x80/0xa0 数组/映射、
   * 0xc0 null、0xc2/0xc3 布尔、0xfa float32、0xfb float64。 */
  function cborDecode(u8, start) {
    let p = start === undefined ? 0 : start;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    function head() {
      const b = u8[p++];
      const major = b >> 5, ai = b & 0x1f;
      let val = ai;
      if (ai === 24) { val = u8[p++]; }
      else if (ai === 25) { val = dv.getUint16(p); p += 2; }
      else if (ai === 26) { val = dv.getUint32(p); p += 4; }
      else if (ai === 27) { const hi = dv.getUint32(p); const lo = dv.getUint32(p + 4); p += 8; val = hi * 4294967296 + lo; }
      return [major, val, ai];
    }
    function value() {
      const b = u8[p];
      if (b === 0xc0) { p++; return { t: 'null' }; }
      if (b === 0xc2) { p++; return { t: 'bool', v: false }; }
      if (b === 0xc3) { p++; return { t: 'bool', v: true }; }
      if (b === 0xc4) { // 本作的字符串
        p++;
        const [, n] = head();
        const s = utf8Decode(u8.subarray(p, p + n)); p += n;
        return { t: 'str', v: s };
      }
      if (b === 0xfa) { p++; const v = dv.getFloat32(p, true); p += 4; return { t: 'num', v }; }
      if (b === 0xfb) { p++; const v = dv.getFloat64(p, true); p += 8; return { t: 'num', v }; }
      const [major, val] = head();
      if (major === 0) return { t: 'num', v: val };
      if (major === 1) return { t: 'num', v: -1 - val };
      if (major === 2) { const a = u8.subarray(p, p + val); p += val; return { t: 'bytes', v: a }; }
      if (major === 3) { const s = utf8Decode(u8.subarray(p, p + val)); p += val; return { t: 'str', v: s }; }
      if (major === 4) { const items = []; for (let i = 0; i < val; i++) items.push(value()); return { t: 'arr', items }; }
      if (major === 5) {
        const pairs = [];
        for (let i = 0; i < val; i++) { const k = value(); pairs.push([k, value()]); }
        return { t: 'map', pairs };
      }
      if (major === 7) return { t: 'null' };
      throw new Error('CBOR 未知类型 ' + b.toString(16) + ' @' + (p - 1));
    }
    const v = value();
    return { value: v, end: p };
  }

  function cborEncode(node) {
    const out = [];
    function uintHead(major, val) {
      if (val < 24) out.push((major << 5) | val);
      else if (val < 256) out.push((major << 5) | 24, val);
      else if (val < 65536) { out.push((major << 5) | 25); out.push((val >> 8) & 0xff, val & 0xff); }
      else if (val < 4294967296) { out.push((major << 5) | 26); out.push((val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff); }
      else throw new Error('CBOR 长度过大');
    }
    function write(n) {
      if (n.t === 'null') { out.push(0xc0); return; }
      if (n.t === 'bool') { out.push(n.v ? 0xc3 : 0xc2); return; }
      if (n.t === 'str') {
        out.push(0xc4);
        const b = utf8Encode(n.v);
        uintHead(0, b.length);
        for (const x of b) out.push(x);
        return;
      }
      if (n.t === 'bytes') { uintHead(2, n.v.length); for (const x of n.v) out.push(x); return; }
      if (n.t === 'num') {
        const v = n.v;
        if (!Number.isInteger(v)) {
          out.push(0xfb);
          const b = new Uint8Array(8);
          new DataView(b.buffer).setFloat64(0, v, false);
          for (const x of b) out.push(x);
          return;
        }
        if (v >= 0) uintHead(0, v); else uintHead(1, -1 - v);
        return;
      }
      if (n.t === 'arr') { uintHead(4, n.items.length); for (const it of n.items) write(it); return; }
      if (n.t === 'map') { uintHead(5, n.pairs.length); for (const [k, v] of n.pairs) { write(k); write(v); } return; }
      throw new Error('CBOR 写不了 ' + n.t);
    }
    write(node);
    return new Uint8Array(out);
  }

  /* 7stars 的 CBOR 用的是「变体」写法：
   *   0x80|n  = 含 n 对键值的映射（不是标准 CBOR 的数组）；
   *   0xc4 <len> <utf8> = 字符串；
   *   c2/c3 布尔、c0 null、0x00-0x17 小整数、18/19 多字节整数。
   * 所以 scriptData 的形状是：82 <马数据键> <值> "7stars_fastbuilder" 85 <5 对>。
   * 只把 "7stars_fastbuilder" 后面那个 map 当映射解，前后字节一律原样保留。 */
  function decodeMapPairs(u8, start) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = start;
    function head() {
      const b = u8[p++];
      const major = b >> 5, ai = b & 0x1f;
      let val = ai;
      if (ai === 24) val = u8[p++];
      else if (ai === 25) { val = dv.getUint16(p); p += 2; }
      else if (ai === 26) { val = dv.getUint32(p); p += 4; }
      else if (ai === 27) { const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); p += 8; val = hi * 4294967296 + lo; }
      return [major, val];
    }
    /* 这个变体里字符串是 c4 + 一个字节长度 + utf8（不是标准 CBOR 的附加信息编码） */
    function str() {
      const b = u8[p++];
      if (b !== 0xc4) throw new Error('不是字符串标记 0x' + b.toString(16));
      const n = u8[p++];
      if (p + n > u8.length) throw new Error('字符串越界');
      const v = utf8Decode(u8.subarray(p, p + n)); p += n;
      return v;
    }
    function value() {
      const b = u8[p];
      if (b === 0xc0) { p++; return { t: 'null' }; }
      if (b === 0xc2) { p++; return { t: 'bool', v: false }; }
      if (b === 0xc3) { p++; return { t: 'bool', v: true }; }
      if (b === 0xc4) { return { t: 'str', v: str() }; }
      if (b === 0xfa) { p++; const v = dv.getFloat32(p, true); p += 4; return { t: 'num', v }; }
      if (b === 0xfb) { p++; const v = dv.getFloat64(p, true); p += 8; return { t: 'num', v }; }
      const [major, val] = head();
      if (major === 0) return { t: 'num', v: val };
      if (major === 1) return { t: 'num', v: -1 - val };
      if (major === 2) { const a = u8.subarray(p, p + val); p += val; return { t: 'bytes', v: a }; }
      if (major === 3) { const s = utf8Decode(u8.subarray(p, p + val)); p += val; return { t: 'str', v: s }; }
      if (major === 4) { const items = []; for (let i = 0; i < val; i++) items.push(value()); return { t: 'arr', items }; }
      if (major === 5) { const pairs = []; for (let i = 0; i < val; i++) pairs.push([value(), value()]); return { t: 'map', pairs }; }
      if (major === 7) return { t: 'null' };
      throw new Error('未知 CBOR 标记 0x' + b.toString(16));
    }
    const b = u8[p];
    if (b < 0x80 || b > 0x9f) throw new Error('映射头不是 0x8n');
    const [major, n] = head();
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const k = value();
      pairs.push([k, value()]);
    }
    return { node: { t: 'map', pairs }, start, end: p };
  }

  function encodeMapPairs(mapNode) {
    const out = [];
    const enc = n => n;
    function uintHead(major, val, forcePairs) {
      if (forcePairs) {
        if (val < 24) out.push(0x80 | val);
        else throw new Error('映射项过多');
        return;
      }
      if (val < 24) out.push((major << 5) | val);
      else if (val < 256) out.push((major << 5) | 24, val);
      else if (val < 65536) { out.push((major << 5) | 25, (val >> 8) & 0xff, val & 0xff); }
      else { out.push((major << 5) | 26); out.push((val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff); }
    }
    function writeStr(s) {
      const b = utf8Encode(s);
      if (b.length > 255) throw new Error('字符串太长');
      out.push(0xc4, b.length);
      for (const x of b) out.push(x);
    }
    function write(n) {
      if (n.t === 'null') { out.push(0xc0); return; }
      if (n.t === 'bool') { out.push(n.v ? 0xc3 : 0xc2); return; }
      if (n.t === 'str') { writeStr(n.v); return; }
      if (n.t === 'bytes') { uintHead(2, n.v.length); for (const x of n.v) out.push(x); return; }
      if (n.t === 'num') {
        const v = n.v;
        if (!Number.isInteger(v)) {
          out.push(0xfb);
          const b = new Uint8Array(8);
          new DataView(b.buffer).setFloat64(0, v, false);
          for (const x of b) out.push(x);
          return;
        }
        if (v >= 0) uintHead(0, v); else uintHead(1, -1 - v);
        return;
      }
      if (n.t === 'arr') { uintHead(4, n.items.length); for (const it of n.items) write(it); return; }
      if (n.t === 'map') { throw new Error('嵌套映射没实现'); }
      throw new Error('写不了 ' + n.t);
    }
    const pairs = mapNode.pairs;
    if (pairs.length < 24) out.push(0x80 | pairs.length);
    else throw new Error('映射项过多');
    for (const [k, v] of pairs) { writeStr(k.v); write(v); }
    return new Uint8Array(out);
  }

  /* 从 scriptData 里取出 7stars 权限映射 */
  function parseFastbuilder(u8) {
    const needle = asciiBytes('7stars_fastbuilder');
    let at = indexOfBytes(u8, needle, 0);
    while (at >= 0) {
      const off = at + needle.length;
      if (u8[off] >= 0x80 && u8[off] <= 0x9f) {
        try {
          const r = decodeMapPairs(u8, off);
          if (r.node.pairs.length) return r;
        } catch (e) { }
      }
      at = indexOfBytes(u8, needle, at + 1);
    }
    return null;
  }
  function fbGet(fb, key) {
    if (!fb) return undefined;
    for (const [k, v] of fb.node.pairs) if (k.t === 'str' && k.v === key) return v;
    return undefined;
  }
  function fbSet(fb, key, val) {
    for (const pair of fb.node.pairs) if (pair[0].t === 'str' && pair[0].v === key) { pair[1] = val; return true; }
    fb.node.pairs.push([{ t: 'str', v: key }, val]);
    return true;
  }

  /* 通用模组扫描：scriptData 里凡是「c4 <长度> <标识> <映射>」形式的块都算一个模组。
   * 7stars 只是其中一种，以后接入别的模组不用改这里。
   *
   * 判定条件（缺一不可）：
   *   1. 标识以字母开头、全是可打印 ASCII
   *   2. 紧跟其后的是映射头 0x80|n
   *   3. 映射能完整解析，且解析完后面正好是下一个键（0xc4）或文件结尾
   *   4. 映射里每个键都是字符串
   * 第 3、4 条是关键：不这么卡，映射里的字符串值会被误判成模组名。
   *
   * safe = 原样重新编码后与原始字节完全一致；不一致的模组标为只读，避免写坏别人的数据。 */
  function scanMods(u8) {
    const out = [];
    if (!u8 || u8.length < 8) return out;
    for (let i = 0; i + 3 < u8.length; i++) {
      if (u8[i] !== 0xc4) continue;
      const n = u8[i + 1];
      if (n < 3 || n > 64 || i + 2 + n >= u8.length) continue;
      let id = '', ok = true;
      for (let j = i + 2; j < i + 2 + n; j++) {
        const c = u8[j];
        if (c < 0x20 || c > 0x7e) { ok = false; break; }
        id += String.fromCharCode(c);
      }
      if (!ok || !/^[A-Za-z0-9_.:\- ]+$/.test(id) || !/[A-Za-z]{3}/.test(id)) continue;
      const mb = u8[i + 2 + n];
      if (mb < 0x80 || mb > 0x9f) continue;
      let r;
      try { r = decodeMapPairs(u8, i + 2 + n); } catch (e) { continue; }
      if (!r.node || !r.node.pairs.length) continue;
      if (r.end !== u8.length && u8[r.end] !== 0xc4) continue;
      let allStr = true;
      for (const [k] of r.node.pairs) if (!k || k.t !== 'str') { allStr = false; break; }
      if (!allStr) continue;
      let safe = false;
      try { safe = eqBytes(encodeMapPairs(r.node), u8.subarray(i + 2 + n, r.end)); } catch (e) { safe = false; }
      out.push({ id, start: i, mapStart: i + 2 + n, end: r.end, node: r.node, safe });
      i = r.end - 1;
    }
    return out;
  }

  /* 把一个模组块替换成新内容：标识那几十个字节原样保留，只重写它后面的映射 */
  function replaceMod(buf, mod) {
    const head = buf.subarray(0, mod.mapStart);
    const mid = encodeMapPairs(mod.node);
    return concat([head, mid, buf.subarray(mod.end)]);
  }

  // ------------------------------------------------------------ LevelDB 读
  function snappyDecompress(src) {
    let p = 0, ulen = 0, shift = 0, b;
    do { b = src[p++]; ulen += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    const out = new Uint8Array(ulen);
    let o = 0;
    while (p < src.length) {
      const tag = src[p++];
      const t = tag & 3;
      if (t === 0) {
        let len = tag >>> 2;
        if (len < 60) len += 1;
        else {
          const n = len - 59; len = 0;
          for (let i = 0; i < n; i++) len += src[p++] * Math.pow(2, 8 * i);
          len += 1;
        }
        out.set(src.subarray(p, p + len), o);
        o += len; p += len;
      } else {
        let len, off;
        if (t === 1) { len = ((tag >>> 2) & 7) + 4; off = ((tag >>> 5) << 8) | src[p++]; }
        else if (t === 2) { len = (tag >>> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
        else { len = (tag >>> 2) + 1; off = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24); p += 4; }
        let s = o - off;
        for (let i = 0; i < len; i++) out[o++] = out[s++];
      }
    }
    return o === ulen ? out : out.subarray(0, o);
  }

  function* blockEntries(block) {
    const len = block.length;
    if (len < 4) return;
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const numRestarts = dv.getUint32(len - 4, true);
    const dataEnd = len - 4 - numRestarts * 4;
    let p = 0;
    let key = new Uint8Array(0);
    while (p < dataEnd) {
      let shared, nonShared, vlen;
      [shared, p] = readVarint(block, p);
      [nonShared, p] = readVarint(block, p);
      [vlen, p] = readVarint(block, p);
      const k = new Uint8Array(shared + nonShared);
      k.set(key.subarray(0, shared), 0);
      k.set(block.subarray(p, p + nonShared), shared);
      p += nonShared;
      const v = block.subarray(p, p + vlen);
      p += vlen;
      key = k;
      yield [k, v];
    }
  }

  const HAS_DS = typeof DecompressionStream !== 'undefined';
  async function inflate(u8, format) {
    return pipeThroughBuffer(new DecompressionStream(format), u8);
  }
  async function decompressBlock(raw, type) {
    if (type === 0) return raw;
    if (type === 1) return snappyDecompress(raw);
    if (type === 4) { if (HAS_DS) return inflate(raw, 'deflate-raw'); throw new Error('浏览器不支持 deflate-raw'); }
    if (type === 2) { if (HAS_DS) return inflate(raw, 'deflate'); throw new Error('浏览器不支持 deflate'); }
    throw new Error('未知块压缩类型 ' + type);
  }

  async function readTable(u8, onPair) {
    if (u8.length < 48) return;
    const footer = u8.subarray(u8.length - 48);
    let p = 0, index;
    let meta;
    [meta, p] = readVarint(footer, p); [meta, p] = readVarint(footer, p);
    [index, p] = readVarint(footer, p);
    let size; [size, p] = readVarint(footer, p);
    const indexBlock = await decompressBlock(u8.subarray(index, index + size), u8[index + size]);
    for (const [, v] of blockEntries(indexBlock)) {
      let off, bhSize;
      [off, p] = readVarint(v, 0);
      [bhSize, p] = readVarint(v, p);
      const dataBlock = await decompressBlock(u8.subarray(off, off + bhSize), u8[off + bhSize]);
      for (const [ik, val] of blockEntries(dataBlock)) onPair(ik, val);
    }
  }

  const LOG_BLOCK = 32768;
  function readLog(u8, onBatch) {
    let p = 0, pending = null;
    while (p + 7 <= u8.length) {
      const blockOff = p % LOG_BLOCK;
      if (LOG_BLOCK - blockOff < 7) { p += LOG_BLOCK - blockOff; continue; }
      const dlen = u8[p + 4] | (u8[p + 5] << 8);
      const type = u8[p + 6];
      if (dlen === 0 && type === 0) { p += LOG_BLOCK - blockOff; continue; }
      const start = p + 7, end = start + dlen;
      if (end > u8.length) break;
      const frag = u8.subarray(start, end);
      if (type === 1) onBatch(frag);
      else if (type === 2) pending = frag;
      else if (type === 3 && pending) pending = concat([pending, frag]);
      else if (type === 4 && pending) { const m = concat([pending, frag]); pending = null; onBatch(m); }
      p = end;
    }
  }

  function parseBatch(buf, onPut) {
    if (buf.length < 12) return;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let seq = Number(dv.getBigUint64(0, true));
    const count = dv.getUint32(8, true);
    let p = 12;
    for (let i = 0; i < count; i++) {
      if (p >= buf.length) break;
      const t = buf[p++];
      let klen; [klen, p] = readVarint(buf, p);
      const key = buf.subarray(p, p + klen); p += klen;
      let val = new Uint8Array(0);
      if (t === 1) { let vlen; [vlen, p] = readVarint(buf, p); val = buf.subarray(p, p + vlen); p += vlen; }
      onPut(key, val, seq + i, t);
    }
  }

  /** files: [{name, data}] → Map<latin1key, {value:Uint8Array, seq}>
   *  单个文件坏掉（游戏正在写、文件被删、拷贝不完整）不会中断整次读取，
   *  而是跳过并通过 onWarn 报出来。 */
  async function readDatabase(files, onProgress, onWarn) {
    const best = new Map();
    const accept = (k, v, seq, type) => {
      const ks = latin1(k);
      const cur = best.get(ks);
      if (!cur || seq > cur.seq) best.set(ks, { key: k, value: v, seq, type });
    };
    let done = 0;
    for (const f of files) {
      if (/\.ldb$/i.test(f.name)) {
        if (!endsWith(f.data, LDB_MAGIC) && !isStandard(f.name, decryptFile(f.name, f.data))) {
          if (onWarn) onWarn(f.name, '不是完整的 SST 文件（可能游戏正在写盘，或拷贝不完整）');
          done++;
          continue;
        }
        try {
        await readTable(f.data, (ik, val) => {
          if (ik.length < 8) return;
          const key = ik.subarray(0, ik.length - 8);
          const tag = ik.subarray(ik.length - 8);
          let seq = 0;
          for (let i = 7; i >= 0; i--) seq = seq * 256 + tag[i];
          const type = seq % 256;
          seq = Math.floor(seq / 256);
          accept(key, val, seq, type);
        });
        } catch (e) {
          if (onWarn) onWarn(f.name, e.message);
          done++;
          continue;
        }
      } else if (/\.log$/i.test(f.name)) {
        readLog(f.data, b => parseBatch(b, (k, v, s, t) => accept(k, v, s, t)));
      }
      done++;
      if (onProgress) onProgress(done, files.length, f.name);
    }
    const out = new Map();
    for (const [k, v] of best) if (v.type === 1) out.set(k, v);
    return out;
  }

  // ------------------------------------------------------------ LevelDB 写
  function encodeHandle(off, size) {
    return concat([varintBytes(off), varintBytes(size)]);
  }

  function buildBlock(entries) {
    // entries: [{ikey:Uint8Array, value:Uint8Array}]
    const body = [];
    const restarts = [0];
    let counter = 0;
    let prevKey = new Uint8Array(0);
    for (const e of entries) {
      const k = e.ikey;
      // 到 restart 点：先记下这一条的起始偏移，再把前缀清零
      // （leveldb 要求 restart 点上的记录 shared 必须为 0，否则 Seek 直接判「数据损坏」）
      if (counter >= 16) {
        restarts.push(bodyLen(body));
        prevKey = new Uint8Array(0);
        counter = 0;
      }
      let shared = 0;
      const max = Math.min(prevKey.length, k.length);
      while (shared < max && prevKey[shared] === k[shared]) shared++;
      const nonShared = k.length - shared;
      const rec = [];
      writeVarint(rec, shared);
      writeVarint(rec, nonShared);
      writeVarint(rec, e.value.length);
      const head = new Uint8Array(rec);
      body.push(head, k.subarray(shared), e.value);
      prevKey = k;
      counter++;
    }
    const tail = [];
    for (const r of restarts) { tail.push(r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, (r >> 24) & 0xff); }
    tail.push(restarts.length & 0xff, (restarts.length >> 8) & 0xff, (restarts.length >> 16) & 0xff, (restarts.length >> 24) & 0xff);
    return concat(body.concat([new Uint8Array(tail)]));
  }
  function bodyLen(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    return n;
  }

  const HAS_CS = typeof CompressionStream !== 'undefined';
  /* 不用 Blob + Response：Chrome 里连续建几万个 Response 会开始抛 "Failed to fetch"。
   * 直接用 writer/reader，稳定得多。 */
  async function pipeThroughBuffer(stream, u8) {
    const writer = stream.writable.getWriter();
    writer.write(u8).catch(() => { });
    writer.close().catch(() => { });
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      total += r.value.length;
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of parts) { out.set(c, p); p += c.length; }
    return out;
  }
  async function deflateRaw(u8) {
    return pipeThroughBuffer(new CompressionStream('deflate-raw'), u8);
  }
  /* 块 + 1 字节压缩类型 + 4 字节 crc；能压就压（类型 4 = raw deflate，和基岩版一致） */
  const BUILD_STATS = { blocks: 0, compressed: 0, rawBytes: 0, storedBytes: 0 };
  async function blockWithTrailer(block, compress) {
    let payload = block, typeVal = 0;
    if (compress && HAS_CS && block.length > 128) {
      let z = null;
      for (let attempt = 0; attempt < 2 && !z; attempt++) {
        try { z = await deflateRaw(block); }
        catch (e) {
          BUILD_STATS.failed = (BUILD_STATS.failed || 0) + 1;
          if (!BUILD_STATS.firstError) BUILD_STATS.firstError = String(e && e.message || e);
        }
      }
      if (z) {
        if (z.length < block.length - 16) { payload = z; typeVal = 4; }
        else BUILD_STATS.notSmaller = (BUILD_STATS.notSmaller || 0) + 1;
      }
    }
    const type = new Uint8Array([typeVal]);
    const crc = new Uint8Array(4);
    // leveldb 的 BlockReader 校验的是 crc32c::Mask 之后的值（不是裸 CRC）
    new DataView(crc.buffer).setUint32(0, maskCrc(crc32c(concat([payload, type]))), true);
    BUILD_STATS.blocks++; BUILD_STATS.rawBytes += block.length; BUILD_STATS.storedBytes += payload.length;
    if (typeVal === 4) BUILD_STATS.compressed++;
    return concat([payload, type, crc]);
  }

  /** entries: [{key:Uint8Array, value:Uint8Array}] 已排序，seq 统一给 */
  async function buildSst(entries, seq, blockSize, compress) {
    blockSize = blockSize || 32768;
    const data = [];
    const handles = [];
    let cur = [];
    let curSize = 0;
    const flush = async () => {
      if (!cur.length) return;
      const block = buildBlock(cur);
      const t = await blockWithTrailer(block, compress);
      // BlockHandle 的 size 是「压缩后、不含 5 字节尾部」的长度
      const payloadSize = t.length - 5;
      handles.push({ off: dataLen(), size: payloadSize, lastKey: cur[cur.length - 1].ikey });
      data.push(t);
      cur = []; curSize = 0;
    };
    for (const e of entries) {
      const tag = new Uint8Array(8);
      const dv = new DataView(tag.buffer);
      dv.setBigUint64(0, (BigInt(seq) << 8n) | 1n, true);
      const ikey = concat([e.key, tag]);
      const item = { ikey, value: e.value };
      cur.push(item);
      curSize += ikey.length + e.value.length + 12;
      if (curSize >= blockSize) await flush();
    }
    await flush();
    function dataLen() { let n = 0; for (const d of data) n += d.length; return n; }

    const index = [];
    const offsets = [];
    let off = 0;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      index.push({ ikey: h.lastKey, value: encodeHandle(h.off, h.size) });
    }
    const indexBlock = buildBlock(index);
    const indexHandle = { off: dataLen(), size: indexBlock.length };
    const indexTrailer = await blockWithTrailer(indexBlock, false);
    const metaBlock = buildBlock([]);
    const metaHandle = { off: indexHandle.off + indexTrailer.length, size: metaBlock.length };
    const metaTrailer = await blockWithTrailer(metaBlock, false);

    const footer = [];
    footer.push(encodeHandle(metaHandle.off, metaHandle.size));
    footer.push(encodeHandle(indexHandle.off, indexHandle.size));
    let flen = 0;
    for (const f of footer) flen += f.length;
    const pad = new Uint8Array(40 - flen);
    return concat([concat(data), indexTrailer, metaTrailer, ...footer, pad, LDB_MAGIC]);
  }

  function logRecord(payload) {
    // 32KB 块切分，返回完整 log 文件内容
    const out = [];
    let p = 0;
    while (p < payload.length || (p === 0 && payload.length === 0)) {
      const blockOff = outLen() % LOG_BLOCK;
      const avail = LOG_BLOCK - blockOff;
      if (avail < 7) { out.push(new Uint8Array(avail)); continue; }
      const cap = avail - 7;
      const n = Math.min(cap, payload.length - p);
      const frag = payload.subarray(p, p + n);
      const first = p === 0, last = p + n >= payload.length;
      const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
      const head = new Uint8Array(7);
      new DataView(head.buffer).setUint32(0, maskCrc(crc32c(concat([new Uint8Array([type]), frag]))), true);
      new DataView(head.buffer).setUint16(4, n, true);
      head[6] = type;
      out.push(head, frag);
      p += n;
      if (n === 0) break;
    }
    function outLen() { let n = 0; for (const x of out) n += x.length; return n; }
    return concat(out);
  }

  function lenPrefixed(u8) { return concat([varintBytes(u8.length), u8]); }

  /** 把一组键值写成完整的 db 目录内容（未加密）
   *  返回 [{name, data}] */
  async function buildDatabase(entries, opts) {
    opts = opts || {};
    const blockSize = opts.blockSize || 32768;
    const targetFileSize = opts.targetFileSize || (4 * 1024 * 1024);
    // 排序
    const arr = entries.slice().sort((a, b) => cmpBytes(a.key, b.key));
    let seq = 1;

    // 切分成多个 SST
    const files = [];
    let group = [];
    let groupSize = 0;
    for (const e of arr) {
      group.push(e);
      groupSize += e.key.length + e.value.length + 16;
      if (groupSize >= targetFileSize) { files.push(group); group = []; groupSize = 0; }
    }
    if (group.length) files.push(group);

    BUILD_STATS.blocks = 0; BUILD_STATS.compressed = 0; BUILD_STATS.rawBytes = 0; BUILD_STATS.storedBytes = 0;
    const out = [];
    const sstMeta = [];
    let number = 2;   // 1 留给 log
    for (const g of files) {
      const data = await buildSst(g, seq, blockSize, opts.compress !== false);
      sstMeta.push({
        number,
        size: data.length,
        smallest: concat([g[0].key, u64(seq, 1)]),
        largest: concat([g[g.length - 1].key, u64(seq, 1)])
      });
      out.push({ name: String(number).padStart(6, '0') + '.ldb', data });
      number++;
    }

    // MANIFEST
    const edit = [];
    writeVarint(edit, 1); edit.push(...lenPrefixed(asciiBytes('leveldb.BytewiseComparator')));
    writeVarint(edit, 2); writeVarint(edit, 1);              // log number = 1
    writeVarint(edit, 3); writeVarint(edit, number);         // next file number
    writeVarint(edit, 4); writeVarint(edit, seq);            // last sequence
    for (const m of sstMeta) {
      writeVarint(edit, 7);      // kNewFile
      writeVarint(edit, 0);      // level
      writeVarint(edit, m.number);
      writeVarint(edit, m.size);
      edit.push(...lenPrefixed(m.smallest));
      edit.push(...lenPrefixed(m.largest));
    }
    const manifestData = logRecord(new Uint8Array(edit));
    out.push({ name: 'MANIFEST-000001', data: manifestData });
    out.push({ name: 'CURRENT', data: asciiBytes('MANIFEST-000001\n') });
    out.push({ name: '000001.log', data: new Uint8Array(0) });
    BUILD_STATS.files = out.length;
    BUILD_STATS.outBytes = out.reduce((a, f) => a + f.data.length, 0);
    return out;
  }

  /* ------------------------------------------------------------ 导出自检
   * 这一层是补的一次教训：只验证「自己的读器能读回来」不够。
   * 自研读器是顺序扫描，既不验块尾 CRC，也不走 restart 数组的二分查找，
   * 所以库里哪怕有两个致命错误也照样「通过」，而游戏那边一个键都读不到。
   * 这里按 leveldb 的真实读取路径验：块尾 CRC 必须是掩码值、restart 必须落在
   * shared==0 的记录上。返回 problems，不抛异常。 */
  async function verifyDatabase(files, onProgress, opts) {
    opts = opts || {};
    const full = opts.full === true;     // 默认只验块尾 CRC（快）；full=true 再逐块解压验 restart
    const problems = [];
    const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
    let ssts = 0, blocks = 0, keys = 0, done = 0;

    async function readBlockChecked(u8, off, size, tag, needBody) {
      if (off < 0 || size < 0 || off + size + 5 > u8.length) { problems.push(tag + '：BlockHandle 越界'); return null; }
      const payload = u8.subarray(off, off + size);
      const type = u8[off + size];
      const stored = u32(u8, off + size + 1);
      const want = maskCrc(crc32c(concat([payload, new Uint8Array([type])])));
      if (stored !== want) {
        problems.push(tag + '：块尾 CRC 不对（存 0x' + stored.toString(16) + '，应为 0x' + want.toString(16) + '）');
      }
      if (needBody === false) return null;
      try { return await decompressBlock(payload, type); }
      catch (e) { problems.push(tag + '：解压失败 ' + (e && e.message)); return null; }
    }

    function parseChecked(body, tag) {
      if (body.length < 4) { problems.push(tag + '：块太短'); return null; }
      const nR = u32(body, body.length - 4) | 0;
      if (nR <= 0) { problems.push(tag + '：restart 数量 ' + nR); return null; }
      const arr = body.length - 4 - 4 * nR;
      if (arr < 0) { problems.push(tag + '：restart 数组越界'); return null; }
      const rs = [];
      for (let i = 0; i < nR; i++) rs.push(u32(body, arr + 4 * i) | 0);
      if (rs[0] !== 0) problems.push(tag + '：restart[0] 不是 0');
      for (let i = 1; i < rs.length; i++) if (rs[i] <= rs[i - 1]) problems.push(tag + '：restart 偏移不递增');
      const set = new Set(rs);
      const out = [];
      let p = 0, prev = new Uint8Array(0);
      while (p < arr) {
        const at = p;
        let sh, ns, vl;
        [sh, p] = readVarint(body, p);
        [ns, p] = readVarint(body, p);
        [vl, p] = readVarint(body, p);
        if (p + ns + vl > arr) { problems.push(tag + '：记录越界'); break; }
        const delta = body.subarray(p, p + ns); p += ns;
        const val = body.subarray(p, p + vl); p += vl;
        if (sh > prev.length) { problems.push(tag + '：shared 大于前一条键的长度'); break; }
        const key = new Uint8Array(sh + ns);
        key.set(prev.subarray(0, sh), 0);
        key.set(delta, sh);
        if (set.has(at) && sh !== 0) problems.push(tag + '：restart 点上的记录 shared=' + sh + '（Seek 会判数据损坏）');
        if (out.length && cmpInternal(out[out.length - 1].key, key) > 0) problems.push(tag + '：键不是升序');
        out.push({ key, value: val });
        prev = key;
      }
      return out;
    }

    for (const f of files) {
      if (!/\.ldb$/i.test(f.name)) continue;
      ssts++;
      const u8 = f.data;
      if (!endsWith(u8, LDB_MAGIC)) { problems.push(f.name + '：文件尾 magic 不对'); continue; }
      const foot = u8.subarray(u8.length - 48);
      let p = 0, mo, ms, io, isz;
      [mo, p] = readVarint(foot, p); [ms, p] = readVarint(foot, p);
      [io, p] = readVarint(foot, p); [isz, p] = readVarint(foot, p);

      const metaBody = await readBlockChecked(u8, mo, ms, f.name + ' [meta]');
      if (metaBody) parseChecked(metaBody, f.name + ' [meta]');
      const idxBody = await readBlockChecked(u8, io, isz, f.name + ' [index]');
      if (!idxBody) { done++; continue; }
      const idx = parseChecked(idxBody, f.name + ' [index]');
      if (!idx) { done++; continue; }
      blocks++;
      if (!idx.length) problems.push(f.name + '：index 为空，整个文件等于没数据');
      for (let i = 0; i < idx.length; i++) {
        let off, size, q = 0;
        [off, q] = readVarint(idx[i].value, 0);
        [size] = readVarint(idx[i].value, q);
        const body = await readBlockChecked(u8, off, size, f.name + ' 块#' + i, full);
        if (full) {
          if (!body) continue;
          blocks++;
          const b = parseChecked(body, f.name + ' 块#' + i);
          if (b) keys += b.length;
        }
      }
      done++;
      if (onProgress) onProgress(done, ssts);
    }
    return { ok: problems.length === 0, ssts, blocks, keys, problems };
  }

  function u64(seq, type) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, (BigInt(seq) << 8n) | BigInt(type), true);
    return b;
  }
  function cmpBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }

  /* 内部键比较：用户键升序；用户键相同时按 8 字节 tag 的数值降序（leveldb 的 InternalKeyComparator）。
   * 不能直接按字节比——用户键是二进制（区块键里全是 0），前缀关系会被 tag 的首字节搅乱。 */
  function cmpInternal(a, b) {
    const ua = a.subarray(0, Math.max(0, a.length - 8));
    const ub = b.subarray(0, Math.max(0, b.length - 8));
    const c = cmpBytes(ua, ub);
    if (c) return c;
    if (a.length < 8 || b.length < 8) return a.length - b.length;
    let ta = 0, tb = 0;
    for (let k = 7; k >= 0; k--) { ta = ta * 256 + a[a.length - 8 + k]; tb = tb * 256 + b[b.length - 8 + k]; }
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  }

  // ------------------------------------------------------------ ZIP
  async function readZip(u8, onProgress) {
    // 找 EOCD
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);
    let p = cdOff;
    const files = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (/\/$/.test(name)) continue;

      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(dataStart, dataStart + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflate(raw, 'deflate-raw');
      else throw new Error('不支持的压缩方式 ' + method + '（' + name + '）');
      files.push({ name, data, usize });
      if (onProgress) onProgress(i + 1, count, name);
    }
    return files;
  }

  function writeZip(files) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = utf8Encode(f.name);
      const crc = crc32(f.data);
      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);   // UTF-8 名字
      dv.setUint16(8, 0, true);        // STORE
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      locals.push(lh, f.data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);
      offset += lh.length + f.data.length;
    }
    const cdSize = bodyLen(central);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return concat([...locals, ...central, eocd]);
  }

  return {
    // 基础
    utf8Encode, utf8Decode, latin1, concat, eqBytes, indexOfBytes, asciiBytes, cmpBytes, cmpInternal,
    crc32, crc32c, readVarint, writeVarint,
    // 网易
    isEncryptedName, isStandard, decryptFile, encryptFile,
    // NBT
    T, TYPE_NAME, nbtParse, nbtParseAuto, nbtWrite, nbtGet, nbtSet, nbtNum,
    // CBOR
    cborDecode, cborEncode, parseFastbuilder, encodeMapPairs, fbGet, fbSet,
    scanMods, replaceMod,
    // LevelDB
    readDatabase, buildDatabase, verifyDatabase, buildStats: () => BUILD_STATS,
    // ZIP
    readZip, writeZip,
  };
});
