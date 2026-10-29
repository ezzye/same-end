/* Metadata framing and interval accounting only. Callers verify the source
 * signature and payload hash before passing pieces to ranges(). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SameEndResilienceWire = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var MODES = ['audio', 'v360', 'v480'], MAX_SAFE = 9007199254740991, MAX_BYTES = 4 * 1024 * 1024;
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function integer(n) { return finite(n) && n >= 0 && n <= MAX_SAFE && Math.floor(n) === n; }
  function id(v) { return typeof v === 'string' && v.length > 0 && v.length <= 100; }
  function canonical(m) { return JSON.stringify(['same-end-piece', 3, m.cast, m.sourceId, m.sourceEpoch, m.programId, m.programStartTime, m.alignmentVersion, m.seq, m.rendition, m.start, m.duration, m.size, m.mime, m.hash]); }
  function identity(m) { return JSON.stringify([m.cast, m.sourceId, m.sourceEpoch, m.rendition, m.seq]); }
  function validate(m, c) {
    if (!m || !c || c.segmentVersion !== 3 || m.v !== 3) throw new Error('Version 3 media is required.');
    if (!id(c.id) || !id(c.sourceId) || !id(c.programId) || !integer(c.sourceEpoch) || !finite(c.epoch) || c.epoch < 0 || c.epoch > MAX_SAFE || c.alignmentVersion !== 1) throw new Error('Invalid source configuration.');
    if (!id(m.cast) || !id(m.sourceId) || !id(m.programId) || m.cast !== c.id || m.sourceId !== c.sourceId || m.programId !== c.programId || m.sourceEpoch !== c.sourceEpoch || m.alignmentVersion !== c.alignmentVersion) throw new Error('Unrecognised source identity.');
    if (!Array.isArray(c.renditions) || MODES.indexOf(m.rendition) < 0 || c.renditions.indexOf(m.rendition) < 0) throw new Error('Unrecognised rendition.');
    if (!integer(m.seq) || !finite(m.start) || m.start < 0 || m.start > MAX_SAFE || !finite(m.programStartTime) || m.programStartTime < 0 || m.programStartTime >= 604800000 || Math.abs(m.programStartTime - (m.start - c.epoch)) > 1 || !finite(m.duration) || m.duration < 1 || m.duration > 10000 || !integer(m.size) || m.size < 1 || m.size > MAX_BYTES) throw new Error('Invalid media timing or size.');
    if (m.mime !== 'application/vnd.apple.mpegurl' || (c.mime && m.mime !== c.mime) || typeof m.hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.hash)) throw new Error('Invalid media format or hash.');
    return true;
  }
  function ranges(segments, epoch) {
    if (!Array.isArray(segments) || !finite(epoch) || epoch < 0) return [];
    var streams = { audio: [], v360: [], v480: [] }, identityKey = null;
    segments.forEach(function (piece) {
      var m = piece && (piece.meta || piece); if (!m) return;
      var candidate = JSON.stringify([m.cast, m.sourceId, m.sourceEpoch, m.programId, m.alignmentVersion]);
      try { validate(m, { segmentVersion: 3, id: m.cast, sourceId: m.sourceId, sourceEpoch: m.sourceEpoch, programId: m.programId, alignmentVersion: 1, epoch: epoch, mime: m.mime, renditions: MODES }); } catch (_) { return; }
      if (identityKey === null) identityKey = candidate;
      if (identityKey !== candidate) return;
      streams[m.rendition].push({ start: (m.start - epoch) / 1000, end: (m.start + m.duration - epoch) / 1000, seq: m.seq });
    });
    var result = [];
    MODES.forEach(function (mode) {
      var merged = [];
      streams[mode].sort(function (a, b) { return a.start - b.start || a.end - b.end || a.seq - b.seq; });
      streams[mode].forEach(function (piece) {
        var last = merged[merged.length - 1];
        if (last && piece.start <= last.end + 0.100000001) {
          last.end = Math.max(last.end, piece.end); last.firstSeq = Math.min(last.firstSeq, piece.seq); last.lastSeq = Math.max(last.lastSeq, piece.seq);
        } else merged.push({ rendition: mode, start: piece.start, end: piece.end, firstSeq: piece.seq, lastSeq: piece.seq });
      });
      result = result.concat(merged.slice(-16));
    });
    return result;
  }
  return { canonical: canonical, identity: identity, validate: validate, ranges: ranges };
});
