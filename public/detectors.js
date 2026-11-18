// Deliberately narrow pilot detectors. Their output always enters the review queue.
export const SHOT_ENGINE = 'rim-crossing/1';
export const PITCH_ENGINE = 'held-swara-yin/1';
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const centsBetween = (hz, target) => 1200 * Math.log2(hz / target);
export function targetHz(settings) {
  return settings.target === 'Custom' ? settings.customHz :
    settings.saHz * ({
      Sa: 1,
      Pa: 1.5,
      'Upper Sa': 2
    } [settings.target] || 1);
}
// Moving orange blobs near the calibrated rim. Stationary wood, the board and rim
// are suppressed by comparing with the previous sampled frame.
export function locateBall(frame, previous, width, height, rim, last) {
  if (!previous) return null;
  const rw = rim.width * width,
    cx = rim.x * width,
    cy = rim.y * height;
  const x0 = Math.max(0, Math.floor(cx - 2.5 * rw)),
    x1 = Math.min(width, Math.ceil(cx + 2.5 * rw));
  const y0 = Math.max(0, Math.floor(cy - 3.2 * rw)),
    y1 = Math.min(height, Math.ceil(cy + 2.3 * rw));
  const w = x1 - x0,
    h = y1 - y0,
    marked = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = ((y + y0) * width + x + x0) * 4;
      const r = frame[k],
        g = frame[k + 1],
        b = frame[k + 2];
      const delta = Math.abs(r - previous[k]) + Math.abs(g - previous[k + 1]) + Math.abs(b - previous[k + 2]);
      if (r > 72 && r > g * 1.27 && g > b * 1.08 && r - b > 43 && delta > 48) marked[y * w + x] = 1;
    }
  let best = null,
    bestScore = -Infinity;
  const stack = new Int32Array(w * h);
  for (let pos = 0; pos < marked.length; pos++) {
    if (!marked[pos]) continue;
    let n = 0,
      sx = 0,
      sy = 0,
      xmin = w,
      xmax = 0,
      ymin = h,
      ymax = 0,
      top = 1;
    stack[0] = pos;
    marked[pos] = 0;
    while (top) {
      const k = stack[--top],
        x = k % w,
        y = Math.floor(k / w);
      n++;
      sx += x;
      sy += y;
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
      const push = j => {
        if (marked[j]) {
          marked[j] = 0;
          stack[top++] = j;
        }
      };
      if (x > 0) push(k - 1);
      if (x + 1 < w) push(k + 1);
      if (y > 0) push(k - w);
      if (y + 1 < h) push(k + w);
    }
    const bw = xmax - xmin + 1,
      bh = ymax - ymin + 1;
    if (n < Math.max(4, rw * rw * .017) || n > rw * rw * .65 || bw / bh < .4 || bw / bh > 2.2 || bw > rw * .95 ||
      bh > rw * .95) continue;
    const x = sx / n + x0,
      y = sy / n + y0;
    const score = n / (bw * bh) - Math.abs(Math.sqrt(n) / rw - .36) -
      (last?.x != null ? .18 * Math.hypot(x - last.x, y - last.y) / rw : .10 * Math.abs(x - cx) / rw);
    if (score > bestScore) {
      bestScore = score;
      best = {
        x,
        y
      };
    }
  }
  return best;
}
export function basketCrossings(samples, rim, width, height) {
  const rw = rim.width * width,
    cx = rim.x * width,
    cy = rim.y * height;
  let track = [],
    candidate = null,
    lastEvent = -10000;
  const events = [];
  for (const s of samples) {
    if (!s) continue;
    const prev = track.at(-1);
    if (prev && (s.t - prev.t > 300 || Math.hypot(s.x - prev.x, s.y - prev.y) > 2 * rw)) {
      track = [];
      candidate = null;
    }
    const p = track.at(-1);
    if (p && s.y > p.y && p.y < cy && s.y >= cy && s.t - lastEvent > 800) {
      const u = (cy - p.y) / (s.y - p.y),
        x = p.x + u * (s.x - p.x);
      const above = track.some(q => s.t - q.t < 600 && q.y < cy - .18 * rw && Math.abs(q.x - cx) < 1.5 * rw);
      if (above && Math.abs(x - cx) <= rw * .43) candidate = {
        time: Math.round(p.t + u * (s.t - p.t)),
        x
      };
    }
    if (candidate && s.t - candidate.time > 480) candidate = null;
    if (candidate && s.y > cy + .20 * rw && Math.abs(s.x - cx) < rw * .8) {
      events.push(candidate.time);
      lastEvent = candidate.time;
      candidate = null;
    }
    track.push(s);
    if (track.length > 10) track.shift();
  }
  return events;
}
// Estimate a period with a normalized difference function. This avoids using
// the loudest harmonic as the note. Reject ambiguous and quiet windows.
export function estimatePitch(data, offset, rate) {
  const minLag = Math.floor(rate / 2000),
    maxLag = Math.ceil(rate / 50) + 2,
    window = 480;
  if (offset + window + maxLag >= data.length) return null;
  let power = 0;
  for (let i = 0; i < window; i++) power += data[offset + i] ** 2;
  if (power / window < .00010) return null;
  const diff = new Float64Array(maxLag + 1);
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const delta = data[offset + i] - data[offset + i + lag];
      sum += delta * delta;
    }
    running += sum;
    diff[lag] = running ? sum * lag / running : 1;
  }
  for (let lag = Math.max(2, minLag); lag < maxLag; lag++) {
    if (diff[lag] > .12) continue;
    while (lag + 1 < maxLag && diff[lag + 1] < diff[lag]) lag++;
    const a = diff[lag - 1],
      b = diff[lag],
      c = diff[lag + 1],
      den = 2 * (2 * b - a - c);
    const correction = den ? Math.max(-.5, Math.min(.5, (c - a) / den)) : 0;
    return {
      hz: rate / (lag + correction),
      clarity: 1 - b
    };
  }
  return null;
}
export function heldNotes(pcm, sampleRate, target, progress = () => {}) {
  const rate = 8000,
    step = sampleRate / rate,
    down = new Float32Array(Math.floor(pcm.length / step));
  for (let i = 0; i < down.length; i++) {
    const first = Math.floor(i * step),
      last = Math.min(pcm.length, Math.max(first + 1, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let k = first; k < last; k++) sum += pcm[k];
    down[i] = sum / (last - first);
  }
  const hop = 240,
    notes = [];
  let group = [];
  const flush = () => {
    if (group.length >= 10) {
      const frequencies = group.map(x => x.hz),
        hz = median(frequencies);
      const spreadCents = median(frequencies.map(f => Math.abs(centsBetween(f, hz))));
      if (spreadCents <= 20) notes.push({
        startMs: group[0].t,
        endMs: Math.min(Math.round(pcm.length / sampleRate * 1000), group.at(-1).t + 60),
        hz,
        targetHz: target,
        cents: centsBetween(hz, target),
        spreadCents,
        confidence: spreadCents < 8 && median(group.map(x => x.clarity)) > .93 ? 'high' : 'medium'
      });
    }
    group = [];
  };
  for (let i = 0; i + 630 < down.length; i += hop) {
    const p = estimatePitch(down, i, rate);
    if (!p) {
      flush();
      continue;
    }
    if (group.length && Math.abs(centsBetween(p.hz, median(group.slice(-7).map(x => x.hz)))) > 45) flush();
    group.push({
      ...p,
      t: Math.round(i / rate * 1000)
    });
    if ((i / hop) % 30 === 0) progress(i / down.length);
  }
  flush();
  return notes;
}
