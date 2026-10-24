// Transport envelope only. The contained HLS playlists and CMAF files are
// emitted by the maintained packager and are never rewritten as MP4 here.
export const HLS_MIME = 'application/vnd.apple.mpegurl';
export const HLS_PROFILE = 'hls-cmaf-v1';
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_HEADER = 64 * 1024, MAX_FILES = 24;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export function validPath(path) {
  return typeof path === 'string' && path.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(m3u8|m4s|mp4)$/.test(path) &&
    !path.split('/').some(p => p === '.' || p === '..' || !p);
}
function view(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Invalid HLS file bytes.');
}
function time(value) { return Number.isFinite(value) && value >= 0 && value < 7 * 24 * 3600; }
function validateHeader(header, total) {
  if (!header || header.format !== 'same-end-hls-files' || header.version !== 1 ||
      !time(header.start) || !Number.isFinite(header.duration) || header.duration < .001 || header.duration > 10 ||
      !time(header.playlistStart) || header.playlistStart > header.start + .1 ||
      !Array.isArray(header.files) || !header.files.length || header.files.length > MAX_FILES) throw new Error('Invalid HLS transport envelope.');
  const paths = new Set(); let cursor = 0;
  for (const f of header.files) {
    if (!validPath(f.path) || paths.has(f.path) || !Number.isSafeInteger(f.offset) || f.offset !== cursor ||
        !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > MAX_BUNDLE_BYTES ||
        !['application/vnd.apple.mpegurl','application/x-mpegURL','video/mp4','audio/mp4','video/iso.segment','audio/iso.segment','application/mp4'].includes(f.mime) ||
        (f.start !== undefined && !time(f.start))) throw new Error('Invalid HLS file index.');
    if (f.path.endsWith('.m3u8') !== /mpegurl/i.test(f.mime)) throw new Error('HLS file type mismatch.');
    cursor += f.size; paths.add(f.path);
  }
  if (cursor !== total || !paths.has('master.m3u8')) throw new Error('Incomplete HLS transport envelope.');
}
export function encodeBundle({files, start, duration, playlistStart = 0, final = false}) {
  if (!Array.isArray(files)) throw new Error('Missing HLS files.');
  let offset = 0;
  const data = files.map(f => view(f.bytes));
  const header = {format:'same-end-hls-files',version:1,start,duration,playlistStart,final:final === true,
    files:files.map((f,i) => { const entry={path:f.path,mime:f.mime,offset,size:data[i].byteLength};if(f.start!==undefined)entry.start=f.start;offset+=entry.size;return entry; })};
  validateHeader(header, offset);
  const json = encoder.encode(JSON.stringify(header));
  if (json.byteLength > MAX_HEADER || 4 + json.byteLength + offset > MAX_BUNDLE_BYTES) throw new Error('HLS transport envelope is too large.');
  const bytes = new Uint8Array(4 + json.byteLength + offset);
  new DataView(bytes.buffer).setUint32(0,json.byteLength);bytes.set(json,4);
  let position=4+json.byteLength;for(const file of data){bytes.set(file,position);position+=file.byteLength;}
  return bytes.buffer;
}
export function decodeBundle(value) {
  const bytes=view(value);
  if(bytes.byteLength<6||bytes.byteLength>MAX_BUNDLE_BYTES)throw new Error('Invalid HLS transport envelope size.');
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  if(length>MAX_HEADER||length>bytes.byteLength-4)throw new Error('Invalid HLS transport envelope header.');
  let header;try{header=JSON.parse(decoder.decode(bytes.subarray(4,4+length)));}catch{throw new Error('Invalid HLS transport envelope header.');}
  validateHeader(header,bytes.byteLength-4-length);
  return {start:header.start,duration:header.duration,playlistStart:header.playlistStart,final:header.final===true,
    files:header.files.map(f=>({path:f.path,mime:f.mime,...(f.start!==undefined?{start:f.start}:{}),bytes:bytes.slice(4+length+f.offset,4+length+f.offset+f.size).buffer}))};
}
