import {FOOTBALL_ENGINE, footballKinds, frameStep} from './football.js';
// The exported report is also the IndexedDB draft format. Media bytes are never stored.
export const SCHEMA = 'chalachitra.report';
export const VERSION = 1;
export const MAX_EVENTS = 2000;
export const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const modes = ['basketball', 'violin', 'football'];
const statuses = ['proposed', 'confirmed', 'dismissed'];
const kinds = ['basket', 'pitch', 'note', ...Object.keys(footballKinds)];
const confidenceLevels = ['unknown', 'low', 'medium', 'high', 'reviewed'];
const fields = ['event', 'timing', 'points', 'team', 'player', 'pitch'];
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export function timeLabel(ms, precise = false) {
  const time = Math.max(0, Math.round(ms || 0));
  const m = Math.floor(time / 60000);
  const s = String(Math.floor(time / 1000) % 60).padStart(2, '0');
  return m + ':' + s + (precise ? '.' + String(time % 1000).padStart(3, '0') : '');
}
export function parseTime(text) {
  const match = /^(?:(\d+):([0-5]\d)|(\d+))(?:\.(\d{1,3}))?$/.exec(String(text).trim());
  if (!match) return NaN;
  return 1000 * (match[3] ? Number(match[3]) : Number(match[1]) * 60 + Number(match[2])) +
    Number((match[4] || '').padEnd(3, '0'));
}
export function youtubeId(input) {
  try {
    const u = new URL(input);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(u.hostname)) id = /^\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
    if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) {
      if (u.pathname === '/watch' || u.pathname === '/watch/') id = u.searchParams.get('v');
      else id = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
    }
    if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(u.hostname))
      id = /^\/embed\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}
export function sessionKey(report) {
  return report.source.sha256 || 'youtube:' + report.source.youtubeId;
}
export function newReport(source, mode) {
  return {
    schema: SCHEMA,
    version: VERSION,
    id: uid(),
    mode,
    source,
    createdAt: now(),
    updatedAt: now(),
    settings: {
      rim: null,
      saHz: 220,
      target: 'Sa',
      customHz: 220
    },
    events: []
  };
}
export function newEvent(kind, startMs, options = {}) {
  return {
    id: uid(),
    kind,
    startMs,
    endMs: startMs,
    title: '',
    note: '',
    status: 'confirmed',
    points: null,
    team: '',
    player: '',
    origin: 'manual',
    detector: null,
    confidence: {},
    evidence: '',
    measurement: null,
    ...options
  };
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function textField(value, max = 500) {
  return typeof value === 'string' && value.length <= max;
}
const finite = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
export function validateReport(r) {
  ensure(r?.schema === SCHEMA && r.version === VERSION, 'Choose a ChalaChitra version 1 JSON report.');
  ensure(modes.includes(r.mode) && textField(r.id, 100) && r.id.length, 'Invalid session identity.');
  ensure([r.createdAt, r.updatedAt].every(d => textField(d, 40) && Number.isFinite(Date.parse(d))),
    'Invalid report dates.');
  const s = r.source;
  ensure(s && textField(s.name, 255) && s.name.trim() && (s.sha256 === null || /^[0-9a-f]{64}$/.test(s.sha256)) &&
    (s.youtubeId === null || typeof s.youtubeId === 'string' && /^[\w-]{11}$/.test(s.youtubeId)) &&
    (s.sha256 || s.youtubeId), 'Invalid recording information.');
  ensure(Number.isInteger(s.durationMs) && finite(s.durationMs, 0, 86400000) && (s.durationMs || !s.sha256),
    'Invalid recording duration.');
  if (r.footballFileSignature !== undefined)
    ensure(typeof r.footballFileSignature === 'string' && /^[0-9a-f]{64}$/.test(r.footballFileSignature), 'Invalid football recording signature.');
  if (r.footballScan !== undefined) {
    const scan = r.footballScan;
    ensure(scan && scan.engine === FOOTBALL_ENGINE && Number.isInteger(scan.samples) && finite(scan.samples, 1, 3202) &&
      scan.stepSeconds === frameStep(s.durationMs / 1000), 'Invalid football scan summary.');
  }
  const g = r.settings;
  ensure(g && finite(g.saHz, 50, 1000) && finite(g.customHz, 50, 1600) && ['Sa', 'Pa', 'Upper Sa', 'Custom']
    .includes(g.target), 'Invalid pitch settings.');
  ensure(g.rim === null || (g.rim && finite(g.rim.x, 0, 1) && finite(g.rim.y, 0, 1) &&
    finite(g.rim.width, .012, .8)), 'Invalid rim calibration.');
  ensure(Array.isArray(r.events) && r.events.length <= MAX_EVENTS, 'Too many events in the report.');
  const ids = new Set();
  for (const e of r.events) {
    ensure(e && textField(e.id, 100) && e.id.length && !ids.has(e.id), 'Duplicate or missing event ID.');
    ids.add(e.id);
    ensure(kinds.includes(e.kind) && statuses.includes(e.status) && ['manual', 'analysis'].includes(e.origin),
      'Invalid event type or status.');
    ensure([e.startMs, e.endMs].every(v => Number.isInteger(v) && finite(v, 0, s.durationMs || 86400000)) &&
      e.endMs >= e.startMs, 'An event is outside the recording.');
    ensure([null, 1, 2, 3].includes(e.points) && [e.title, e.note, e.team, e.player, e.evidence].every(x =>
      textField(x, 900)), 'Invalid event fields.');
    ensure(e.detector === null || textField(e.detector, 80), 'Invalid detector version.');
    ensure(e.confidence && typeof e.confidence === 'object' && !Array.isArray(e.confidence) &&
      Object.entries(e.confidence).every(([k, v]) => fields.includes(k) && confidenceLevels.includes(v)),
      'Invalid field confidence.');
    ensure(e.measurement === null || (e.kind === 'pitch' && e.measurement && ['hz', 'targetHz', 'cents',
        'spreadCents'
      ].every(k => Number.isFinite(e.measurement[k])) &&
      finite(e.measurement.hz, 20, 5000) && finite(e.measurement.targetHz, 20, 5000) &&
      textField(e.measurement.target, 50)), 'Invalid pitch measurement.');
  }
  return r;
}
export function displayTitle(e) {
  if (e.title) return e.title;
  if (e.kind === 'basket') return e.status === 'confirmed' ? 'Made basket' : 'Possible basket';
  if (e.kind === 'pitch') return (e.measurement?.target || 'Swara') + ' · held note';
  return footballKinds[e.kind] || 'Observation';
}
export function totals(events) {
  const baskets = events.filter(e => e.kind === 'basket' && e.status === 'confirmed');
  return {
    baskets: baskets.length,
    points: baskets.reduce((n, e) => n + (e.points || 0), 0),
    unknown: baskets.filter(e => e.points === null).length,
    pending: events.filter(e => e.status === 'proposed').length
  };
}
export function vtt(report) {
  const stamp = t => {
    const ms = Math.max(0, t);
    return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' +
      String(Math.floor(ms / 60000) % 60).padStart(2, '0') + ':' +
      String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
  };
  const clean = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(
    /[\r\n]+/g, ' ');
  const cues = report.events.filter(e => e.status !== 'dismissed').sort((a, b) => a.startMs - b.startMs).map(e => {
    const end = e.endMs > e.startMs ? e.endMs : Math.min(e.startMs + 1500, report.source.durationMs || e
      .startMs + 1500);
    const start = Math.max(0, Math.min(e.startMs, end - 1));
    const details = [e.status === 'proposed' ? '[Proposed]' : '', displayTitle(e), e.points ? e.points +
      ' pt' : '',
      e.team, e.player, e.measurement ? Math.round(e.measurement.cents) + ' cents' : '', e.note
    ].filter(Boolean).join(' · ');
    return stamp(start) + ' --> ' + stamp(Math.max(start + 1, end)) + '\n' + clean(details);
  });
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}
export async function digest(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join('');
}
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const req = indexedDB.open('chalachitra-drafts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sessions');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      database = null;
      reject(req.error);
    };
  });
  return database;
}
// A transaction checks the revision last seen by this tab before writing. A
// second tab can export its unsaved changes instead of overwriting newer work.
const seenRevisions = new Map();
const revisionOf = value => value ? (value._draftRevision || value.updatedAt) : null;

function withoutRevision(value) {
  if (!value) return value;
  const {
    _draftRevision,
    ...report
  } = value;
  return report;
}
export async function drafts(method, key, report) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const writing = method === 'put';
    const tx = database.transaction('sessions', writing ? 'readwrite' : 'readonly');
    const table = tx.objectStore('sessions');
    const request = method === 'all' ? table.getAll() : table.get(key);
    const nextRevision = writing ? uid() : null;
    let conflict;
    if (writing) {
      request.onsuccess = () => {
        if (revisionOf(request.result) !== (seenRevisions.get(key) || null)) {
          conflict = new Error('Another tab saved a newer draft.');
          conflict.name = 'DraftConflictError';
          tx.abort();
          return;
        }
        table.put({
          ...report,
          _draftRevision: nextRevision
        }, key);
      };
    }
    tx.oncomplete = () => {
      if (writing) {
        seenRevisions.set(key, nextRevision);
        resolve();
      } else if (method === 'all') resolve(request.result.map(withoutRevision));
      else {
        seenRevisions.set(key, revisionOf(request.result));
        resolve(withoutRevision(request.result));
      }
    };
    tx.onabort = tx.onerror = () => reject(conflict || tx.error || new Error(
      'Draft storage is unavailable.'));
  });
}
