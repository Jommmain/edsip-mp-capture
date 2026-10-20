// Minimal ZIP reader (stored + deflate) using DecompressionStream("deflate-raw"). No ZIP64, no encryption.
(function (root) {
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function unzip(buf) {
    const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("zip: end of central directory not found");
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central directory");
      const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
      const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const off = v.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (flags & 1) throw new Error("zip: encrypted entries not supported");
      if (name.endsWith("/")) continue;
      if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("zip: unsafe path " + name);
      const lh = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const raw = b.subarray(lh, lh + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error(`zip: method ${method} not supported`);
      if (data.length !== size) throw new Error("zip: size mismatch " + name);
      files[name] = data;
    }
    return files;
  }
  const api = { unzip };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdsipUnzip = api;
})(typeof self !== "undefined" ? self : this);
