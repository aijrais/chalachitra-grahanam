// Work in short PCM windows. A sustained narrow high tone is only a whistle candidate.
import {spawn} from 'node:child_process';
const RATE = 12000, SIZE = 512, WINDOW_MS = 1000 * SIZE / RATE;
const hann = new Float64Array(SIZE), reverse = new Uint16Array(SIZE);
const cos = new Float64Array(SIZE / 2), sin = new Float64Array(SIZE / 2);
for (let i = 0; i < SIZE; i++) {
  hann[i] = (1 - Math.cos(2 * Math.PI * i / (SIZE - 1))) / 2;
  reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * SIZE / 2);
  if (i < SIZE / 2) {
    cos[i] = Math.cos(-2 * Math.PI * i / SIZE);
    sin[i] = Math.sin(-2 * Math.PI * i / SIZE);
  }
}

export class WhistleScanner {
  constructor() {
    this.re = new Float64Array(SIZE);
    this.im = new Float64Array(SIZE);
    this.power = new Float64Array(SIZE / 2);
    this.windows = 0;
    this.active = null;
    this.hits = [];
  }

  tone(pcm) {
    const {re, im, power} = this;
    let energy = 0;
    for (let i = 0; i < SIZE; i++) {
      const sample = pcm.readInt16LE(i * 2) / 32768;
      energy += sample * sample;
      re[reverse[i]] = sample * hann[i];
    }
    if (energy / SIZE < 0.00008) return 0;
    im.fill(0);
    for (let length = 2; length <= SIZE; length *= 2) {
      const half = length / 2, step = SIZE / length;
      for (let start = 0; start < SIZE; start += length) {
        for (let k = 0; k < half; k++) {
          const lo = start + k, hi = lo + half, phase = k * step;
          const r = re[hi] * cos[phase] - im[hi] * sin[phase];
          const j = re[hi] * sin[phase] + im[hi] * cos[phase];
          re[hi] = re[lo] - r; im[hi] = im[lo] - j;
          re[lo] += r; im[lo] += j;
        }
      }
    }
    let total = 0, peak = 0;
    for (let i = 4; i < SIZE / 2; i++) {
      power[i] = re[i] * re[i] + im[i] * im[i];
      total += power[i];
      const hz = i * RATE / SIZE;
      if (hz >= 1900 && hz <= 4550 && power[i] > power[peak]) peak = i;
    }
    if (!peak || power[peak - 1] + power[peak] + power[peak + 1] < total * 0.53) return 0;
    return peak * RATE / SIZE;
  }

  finishTone() {
    const a = this.active;
    this.active = null;
    if (!a) return;
    const length = a.last - a.first + 1;
    if (length < 3 || length * WINDOW_MS > 2800 || a.count < length * 0.72) return;
    this.hits.push({startMs: Math.round(a.first * WINDOW_MS), endMs: Math.round((a.last + 1) * WINDOW_MS),
      frequencyHz: Math.round(a.sum / a.count)});
  }

  push(block) {
    const hz = this.tone(block), index = this.windows++;
    const a = this.active;
    if (a && (index - a.last > 2 || (hz && Math.abs(hz - a.sum / a.count) > 480))) this.finishTone();
    if (!hz) return;
    if (!this.active) this.active = {first: index, last: index, count: 0, sum: 0};
    this.active.last = index;
    this.active.count++;
    this.active.sum += hz;
  }

  finish(durationMs) {
    this.finishTone();
    const hits = this.hits.filter(h => h.startMs < durationMs).map(h => ({...h, endMs: Math.min(durationMs, h.endMs)}));
    if (hits.length <= 40) return hits;
    return Array.from({length: 40}, (_, i) => hits[Math.round(i * (hits.length - 1) / 39)]);
  }
}

export async function scanSound(file, durationMs, ffmpeg) {
  const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-i', file, '-map', '0:a:0',
    '-vn', '-af', 'aresample=12000:async=1:first_pts=0', '-ac', '1', '-ar', String(RATE), '-t',
    String(durationMs / 1000), '-f', 's16le', 'pipe:1'], {stdio: ['ignore', 'pipe', 'ignore']});
  const exit = new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('close', resolve);
  });
  const scanner = new WhistleScanner();
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let offset = 0;
      for (; offset + SIZE * 2 <= data.length; offset += SIZE * 2) scanner.push(data.subarray(offset, offset + SIZE * 2));
      tail = data.subarray(offset);
    }
    if (await exit !== 0 || !scanner.windows) return {audioScanned: false, whistles: []};
    return {audioScanned: true, whistles: scanner.finish(durationMs)};
  } finally { if (child.exitCode === null) child.kill(); }
}
