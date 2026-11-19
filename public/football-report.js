import {FOOTBALL_ENGINE, WHISTLE_ENGINE, footballKinds, validateScan} from './football.js';
import {MAX_EVENTS, newEvent} from './session.js';

export function applyMatchScan(report, raw) {
  const result = validateScan(raw, report.source.youtubeId);
  if (report.events.some(e => e.endMs > result.durationMs))
    throw new Error('This recording ends before a saved event. Check that it is the same edit.');
  const engines = result.audioScanned ? [FOOTBALL_ENGINE, WHISTLE_ENGINE] : [FOOTBALL_ENGINE];
  const old = report.events.filter(e => engines.includes(e.detector) && e.status === 'proposed' && !e.reviewedAt);
  const keep = report.events.filter(e => !old.includes(e));
  const near = (a, b) => a.kind === b.kind && Math.abs(a.startMs - b.startMs) <= (a.kind === 'whistle' ? 100 : result.stepSeconds * 1200);
  const sounds = (result.whistles || []).map(w => ({...w, kind: 'whistle'}));
  for (const item of [...result.moments, ...sounds]) {
    if (keep.some(e => near(item, e) || (e.original && near(item, e.original)))) continue;
    if (keep.length >= MAX_EVENTS) throw new Error('The timeline is full. Export your report before adding more events.');
    const prior = old.find(e => near(item, e));
    const sound = item.kind === 'whistle';
    const event = newEvent(item.kind, item.startMs, {
      endMs: sound ? item.endMs : item.startMs,
      status: 'proposed', origin: 'analysis', detector: sound ? WHISTLE_ENGINE : FOOTBALL_ENGINE,
      confidence: {event: 'low', timing: 'medium'},
      evidence: sound ? 'A narrow tone near ' + item.frequencyHz + ' Hz lasted ' + ((item.endMs - item.startMs) / 1000).toFixed(2) +
        ' s. Listen to distinguish a whistle from voices, music or electronic tones.' : item.changedPercent + '% of sampled picture cells changed after brightness correction. ' +
        (item.kind === 'cut' ? 'A camera cut or rapid pan can cause this.' : 'Player movement and camera motion can both produce this signal.')
    });
    if (prior) event.id = prior.id;
    keep.push(event);
  }
  report.events = keep;
  report.source.durationMs = result.durationMs;
  if (result.name.trim()) report.source.name = result.name.trim();
  report.footballScan = {samples: result.samples, stepSeconds: result.stepSeconds, engine: result.engine,
    audioScanned: !!(result.audioScanned || report.footballScan?.audioScanned)};
}

export function footballStats(events) {
  const counts = Object.fromEntries(Object.keys(footballKinds).map(kind => [kind, 0]));
  for (const event of events) {
    if (event.status === 'confirmed' && Object.hasOwn(counts, event.kind)) counts[event.kind]++;
  }
  return counts;
}

// Take the account selector from the address the owner actually opened in
// Web Preview. Only the root and a numeric Google account slot survive.
export function analyserAddress(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
    if (url.protocol !== 'https:' || url.port ||
        !/^(?:[a-z0-9-]+\.)+(?:cloudshell\.dev|cloudworkstations\.dev)$/.test(url.hostname)) return null;
    const accounts = url.searchParams.getAll('authuser');
    if (accounts.length === 1 && /^\d{1,4}$/.test(accounts[0]))
      return url.origin + '/?authuser=' + accounts[0];
    return url.origin;
  } catch { return null; }
}

export function studioOrigin(value) {
  try {
    const u = new URL(value);
    if (u.origin !== value) return null;
    if (u.protocol === 'https:' && !u.port && /^chalachitram-42da6(?:--[a-z0-9-]+)?\.(?:web\.app|firebaseapp\.com)$/.test(u.hostname)) return u.origin;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u.origin;
    return null;
  } catch { return null; }
}
