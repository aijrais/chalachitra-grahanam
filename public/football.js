// Both the phone and the private link analyser compare the same low-resolution frames.
export const FRAME_WIDTH = 96;
export const FRAME_HEIGHT = 54;
export const PIXELS = FRAME_WIDTH * FRAME_HEIGHT;
export const MAX_MATCH_SECONDS = 3 * 3600;
export const MAX_CANDIDATES = 60;
export const FOOTBALL_ENGINE = 'football-motion-v1';
export const WHISTLE_ENGINE = 'football-whistle-v1';
export const footballKinds = Object.freeze({
  goal: 'Goal', shot: 'Shot', save: 'Save', corner: 'Corner', foul: 'Foul', pass: 'Pass',
  activity: 'Motion burst', cut: 'View change', whistle: 'Whistle-like sound'
});

export function frameStep(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_MATCH_SECONDS)
    throw new Error('Choose a match with a known duration of up to three hours.');
  return Math.max(0.5, Math.ceil(seconds / 3200 * 2) / 2);
}

export function grayscale(rgba) {
  const result = new Uint8Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) {
    const at = 4 * i;
    result[i] = (77 * rgba[at] + 150 * rgba[at + 1] + 29 * rgba[at + 2]) >> 8;
  }
  if (result.audioScanned !== undefined || result.whistles !== undefined) {
    if (typeof result.audioScanned !== 'boolean' || !Array.isArray(result.whistles) || result.whistles.length > 40 ||
        (!result.audioScanned && result.whistles.length)) throw new Error('Invalid audio scan.');
    for (const w of result.whistles) {
      if (!w || ![w.startMs, w.endMs, w.frequencyHz].every(Number.isInteger) ||
          w.startMs < 0 || w.endMs <= w.startMs || w.endMs > result.durationMs ||
          w.endMs - w.startMs > 2801 || w.frequencyHz < 1800 || w.frequencyHz > 4650)
        throw new Error('Invalid whistle measurement.');
    }
  }
  return result;
}

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

export function compareFrames(previous, current, timeMs) {
  // Subtract the mean brightness shift so floodlights and exposure changes alone
  // do not look like a burst of play. Ignore the outer border and score graphics.
  let delta = 0, count = 0;
  for (let y = 5; y < FRAME_HEIGHT - 5; y++) {
    for (let x = 4; x < FRAME_WIDTH - 4; x++) {
      const i = y * FRAME_WIDTH + x;
      delta += current[i] - previous[i];
      count++;
    }
  }
  const drift = delta / count;
  let moving = 0, large = 0;
  for (let y = 5; y < FRAME_HEIGHT - 5; y++) {
    for (let x = 4; x < FRAME_WIDTH - 4; x++) {
      const i = y * FRAME_WIDTH + x;
      const difference = Math.abs(current[i] - previous[i] - drift);
      if (difference >= 18) moving++;
      if (difference >= 40) large++;
    }
  }
  return {timeMs, moving: moving / count, large: large / count};
}

export function findMoments(frames, stepSeconds) {
  if (frames.length < 2) return [];
  const baseline = median(frames.map(f => f.moving).sort((a, b) => a - b));
  const deviation = median(frames.map(f => Math.abs(f.moving - baseline)).sort((a, b) => a - b));
  const threshold = Math.max(0.035, baseline + Math.max(0.025, 3 * deviation));
  const candidates = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const cut = frame.moving >= Math.max(0.52, baseline + 0.20) && frame.large >= 0.33;
    const neighbour = Math.max(frames[i - 1]?.moving || 0, frames[i + 1]?.moving || 0);
    if (!cut && (frame.moving < threshold || neighbour < threshold * 0.48)) continue;
    candidates.push({kind: cut ? 'cut' : 'activity', startMs: frame.timeMs,
      strength: frame.moving, changedPercent: Math.round(frame.moving * 100)});
  }
  // One marker per passage. If the match is busy, retain markers from across
  // the whole recording before filling the remaining slots by strength.
  const spacing = Math.max(6500, stepSeconds * 3000);
  const sorted = candidates.sort((a, b) => b.strength - a.strength || a.startMs - b.startMs);
  const chosen = [];
  const bins = new Set();
  const binWidth = Math.max(spacing, frames.at(-1).timeMs / MAX_CANDIDATES);
  function select(item, firstPass) {
    const bin = Math.floor(item.startMs / binWidth);
    if (firstPass && bins.has(bin)) return;
    if (chosen.some(other => Math.abs(other.startMs - item.startMs) < spacing)) return;
    chosen.push(item);
    bins.add(bin);
  }
  for (const firstPass of [true, false]) {
    for (const item of sorted) {
      if (chosen.length === MAX_CANDIDATES) break;
      select(item, firstPass);
    }
  }
  return chosen.sort((a, b) => a.startMs - b.startMs).map(({kind, startMs, changedPercent}) =>
    ({kind, startMs, changedPercent}));
}

export function validateScan(result, expectedId) {
  if (!result || (expectedId !== null && !/^[\w-]{11}$/.test(expectedId || '')) || result.videoId !== expectedId ||
      result.engine !== FOOTBALL_ENGINE || typeof result.name !== 'string' || result.name.length > 255 ||
      !Number.isInteger(result.durationMs) || result.durationMs < 1 || result.durationMs > MAX_MATCH_SECONDS * 1000 ||
      !Number.isInteger(result.samples) || result.samples < 1 || result.samples > 3202 ||
      result.stepSeconds !== frameStep(result.durationMs / 1000) ||
      Math.abs(result.samples - Math.ceil(result.durationMs / (1000 * result.stepSeconds))) > 2 ||
      !Array.isArray(result.moments) || result.moments.length > MAX_CANDIDATES)
    throw new Error('This analysis does not match the selected video or supported format.');
  for (const item of result.moments) {
    if (!item || !['activity', 'cut'].includes(item.kind) || !Number.isInteger(item.startMs) ||
        item.startMs < 0 || item.startMs > result.durationMs || !Number.isInteger(item.changedPercent) ||
        item.changedPercent < 0 || item.changedPercent > 100)
      throw new Error('The analyser returned an invalid match moment.');
  }
  if (result.audioScanned !== undefined || result.whistles !== undefined) {
    if (typeof result.audioScanned !== 'boolean' || !Array.isArray(result.whistles) || result.whistles.length > 40 ||
        (!result.audioScanned && result.whistles.length)) throw new Error('Invalid audio scan.');
    for (const w of result.whistles) {
      if (!w || ![w.startMs, w.endMs, w.frequencyHz].every(Number.isInteger) ||
          w.startMs < 0 || w.endMs <= w.startMs || w.endMs > result.durationMs ||
          w.endMs - w.startMs > 2801 || w.frequencyHz < 1800 || w.frequencyHz > 4650)
        throw new Error('Invalid whistle measurement.');
    }
  }
  return result;
}
