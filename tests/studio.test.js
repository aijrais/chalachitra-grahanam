import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash
} from 'node:crypto';
import {
  readFileSync
} from 'node:fs';
import {
  spawnSync
} from 'node:child_process';
import {
  fileURLToPath
} from 'node:url';
import {
  basketCrossings,
  heldNotes,
  locateBall,
  targetHz
} from '../public/detectors.js';
import {
  digest,
  newEvent,
  newReport,
  parseTime,
  sessionKey,
  timeLabel,
  totals,
  validateReport,
  vtt,
  youtubeId
} from '../public/session.js';
const asset = name => fileURLToPath(new URL('../public/assets/' + name, import.meta.url));
const source = {
  name: 'practice.mp4',
  sha256: 'a'.repeat(64),
  youtubeId: null,
  durationMs: 10000
};
const report = () => newReport({
  ...source
}, 'basketball');
test('a corrected timeline round-trips with timestamps, field evidence and a stable media identity', async () => {
  const r = report(),
    bytes = readFileSync(asset('court.mp4'));
  r.source.sha256 = await digest(bytes);
  assert.equal(r.source.sha256, createHash('sha256').update(bytes).digest('hex'));
  r.events = [newEvent('basket', 1925, {
      status: 'confirmed',
      points: 2,
      team: 'Amber',
      player: '7',
      confidence: {
        event: 'reviewed',
        points: 'reviewed'
      },
      evidence: 'Reviewed at the rim.'
    }),
    newEvent('basket', 8150, {
      status: 'proposed'
    }), newEvent('note', 2200, {
      status: 'dismissed',
      title: 'discard'
    })
  ];
  const restored = validateReport(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(restored, r);
  restored.source.name = 'renamed.mp4';
  assert.equal(sessionKey(restored), sessionKey(r));
  assert.deepEqual(totals(restored.events), {
    baskets: 1,
    points: 2,
    unknown: 0,
    pending: 1
  });
  assert.match(vtt(restored), /00:00:01.925 --> 00:00:03.425/);
  assert.match(vtt(restored), /\[Proposed\]/);
  assert.doesNotMatch(vtt(restored), /discard/);
  restored.events[0].points = null;
  assert.equal(totals(restored.events).unknown, 1);
});
test('end-of-clip captions and free text produce valid, literal cues', () => {
  const r = report();
  r.events.push(newEvent('note', 10000, {
    title: '<text> -->\nsecond line & end'
  }));
  assert.match(vtt(r), /00:00:09.999 --> 00:00:10.000/);
  assert.match(vtt(r), /&lt;text&gt; --&gt; second line &amp; end/);
});
test('invalid imports fail before they can replace a draft', () => {
  const r = report();
  r.events.push(newEvent('basket', 10001));
  assert.throws(() => validateReport(r), /outside/);
  r.events[0].startMs = r.events[0].endMs = 5;
  r.events.push(r.events[0]);
  assert.throws(() => validateReport(r), /Duplicate/);
  r.events = [];
  r.source.sha256 = null;
  assert.throws(() => validateReport(r), /recording information/);
  assert.throws(() => validateReport({
    schema: r.schema,
    version: 55
  }), /version 1/);
});
test('reference-only reports and timestamps round-trip without a local file', () => {
  const id = 'abcdefghijk';
  for (const url of ['https://youtu.be/' + id, 'https://www.youtube.com/watch?v=' + id,
      'https://youtube.com/shorts/' + id
    ]) assert.equal(youtubeId(url), id);
  for (const url of ['https://youtube.com.attacker.invalid/watch?v=' + id, 'javascript:alert(1)',
      'https://x@youtube.com/watch?v=' + id
    ]) assert.equal(youtubeId(url), null);
  const r = newReport({
    name: 'Practice reference',
    sha256: null,
    youtubeId: id,
    durationMs: 0
  }, 'violin');
  r.events = [newEvent('note', parseTime('1:23.450'))];
  assert.equal(timeLabel(validateReport(r).events[0].startMs, true), '1:23.450');
  assert.equal(sessionKey(r), 'youtube:' + id);
  assert(Number.isNaN(parseTime('1:72')));
  assert(Number.isNaN(parseTime('-3')));
});
test('motion detector finds both authored rim crossings and ignores the wide throw', t => {
  const w = 400,
    h = 225,
    rim = {
      x: 645 / 960,
      y: 199 / 540,
      width: 44 / 960
    };
  const proc = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', asset('court.mp4'), '-vf',
    'fps=12,scale=400:225', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'
  ], {
    maxBuffer: 64 * 1024 * 1024
  });
  if (proc.error?.code === 'ENOENT') {
    t.skip('FFmpeg is needed for the encoded-video regression');
    return;
  }
  assert.equal(proc.status, 0, proc.stderr.toString());
  const stride = w * h * 4,
    samples = [];
  let prev = null,
    last = null,
    lastT = -1000;
  for (let i = 0; i < proc.stdout.length / stride; i++) {
    const frame = proc.stdout.subarray(i * stride, (i + 1) * stride),
      time = i / 12 * 1000;
    const ball = locateBall(frame, prev, w, h, rim, time - lastT < 300 ? last : null);
    if (ball) {
      last = ball;
      lastT = time;
      samples.push({
        ...ball,
        t: time
      });
    }
    prev = frame;
  }
  const times = basketCrossings(samples, rim, w, h);
  assert.equal(times.length, 2);
  assert(Math.abs(times[0] - 1900) < 100);
  assert(Math.abs(times[1] - 8150) < 100);
  assert.deepEqual(basketCrossings([], rim, w, h), []);
});
test('pitch analysis finds the two held intervals and preserves the sign of detuning', () => {
  const wav = readFileSync(asset('held-sa.wav'));
  const raw = wav.subarray(wav.indexOf('data') + 8);
  const pcm = Float32Array.from(new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2), v => v / 32768);
  const notes = heldNotes(pcm, 22050, 220);
  assert.equal(notes.length, 2);
  assert(Math.abs(notes[0].cents) < 2);
  assert(Math.abs(notes[1].cents + 22) < 2);
  assert(notes[0].endMs < notes[1].startMs);
  assert.deepEqual(heldNotes(new Float32Array(16000), 8000, 220), []);
  assert.equal(targetHz({
    target: 'Pa',
    saHz: 220
  }), 330);
  assert.equal(targetHz({
    target: 'Custom',
    saHz: 220,
    customHz: 293.7
  }), 293.7);
});
