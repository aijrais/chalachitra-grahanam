import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {FOOTBALL_ENGINE, FRAME_HEIGHT, FRAME_WIDTH, PIXELS, compareFrames, frameStep, findMoments, validateScan} from '../public/football.js';
import {applyMatchScan, analyserOrigin, footballStats, studioOrigin} from '../public/football-report.js';
import {newReport, newEvent, sessionKey, validateReport, vtt, youtubeId} from '../public/session.js';
import {analyseFile} from '../scripts/match_frames.mjs';
import {openYouTube} from '../public/youtube-player.js';

const ids = ['Ab1Cd2Ef3_4', 'Z9-y8X7w6V5'];
const source = id => ({youtubeId: id, sha256: null, name: 'Match', durationMs: 0});
const scan = (id, moments) => ({videoId: id, engine: FOOTBALL_ENGINE, name: 'Training session', durationMs: 90000,
  samples: 180, stepSeconds: 0.5, moments});
const marker = (startMs, kind = 'activity') => ({kind, startMs, changedPercent: 24});

test('mobile links, different matches and off-site URLs preserve video identities', () => {
  for (const id of ids) {
    for (const url of ['https://youtu.be/' + id + '/?si=shared', 'https://m.youtube.com/watch?v=' + id + '&t=50',
      'https://youtube.com/shorts/' + id, 'https://www.youtube-nocookie.com/embed/' + id,
      'https://youtube.com/live/' + id + '?si=share', 'https://www.youtube.com/watch?v=' + id + '&list=playlist'])
      assert.equal(youtubeId(url), id);
  }
  for (const bad of ['https://youtube.com.example.test/watch?v=' + ids[0], 'https://youtube.com/playlist?list=abc',
    'https://youtu.be/example/another', 'https://youtu.be:81/' + ids[0]]) assert.equal(youtubeId(bad), null);
});

test('stationary frames and uniform exposure changes produce no proposed match events', () => {
  const dark = new Uint8Array(PIXELS).fill(20), light = new Uint8Array(PIXELS).fill(80);
  assert.deepEqual(findMoments([compareFrames(dark, light, 500), compareFrames(light, dark, 1000)], 0.5), []);
  assert.equal(frameStep(2929), 1);
  assert.equal(frameStep(10800), 3.5);
  assert.throws(() => frameStep(10801));
  assert.throws(() => frameStep(Infinity));
});

test('motion and view changes produce separated timestamped proposals across the full match', () => {
  const frames = [], bg = new Uint8Array(PIXELS).fill(70);
  let previous = bg;
  for (let t = 0; t <= 70; t++) {
    const frame = bg.slice();
    if ([12, 13, 48, 49].includes(t)) {
      const start = t % 2 ? 48 : 25;
      for (let y = 12; y < 36; y++) frame.fill(190, y * FRAME_WIDTH + start, y * FRAME_WIDTH + start + 11);
    }
    if (t === 32) for (let y = 0; y < FRAME_HEIGHT; y++)
      frame.fill(y < FRAME_HEIGHT / 2 ? 15 : 230, y * FRAME_WIDTH, (y + 1) * FRAME_WIDTH);
    frames.push(compareFrames(previous, frame, t * 1000));
    previous = frame;
  }
  const result = findMoments(frames, 1);
  assert.deepEqual(result.map(x => x.kind), ['activity', 'cut', 'activity']);
  const expected = [13000, 32000, 49000];
  result.forEach((m, i) => assert(Math.abs(m.startMs - expected[i]) <= 1000));
  assert(result.every(m => m.changedPercent > 0));
});

test('two independent link scans round-trip and repeat without duplicating, changing or counting reviewed proposals', () => {
  for (const id of ids) {
    const r = newReport(source(id), 'football');
    const input = scan(id, [marker(12300), marker(42600, 'cut')]);
    applyMatchScan(r, input);
    assert.equal(r.events.length, 2);
    const [first, second] = r.events.map(e => e.id);
    applyMatchScan(r, input);
    assert.deepEqual(r.events.map(e => e.id), [first, second]);
    r.events[0].original = {kind: 'activity', startMs: 12300, endMs: 12300};
    Object.assign(r.events[0], {kind: 'goal', startMs: 13400, endMs: 13400, status: 'confirmed', reviewedAt: r.updatedAt, team: 'Blue', player: '4'});
    Object.assign(r.events[1], {status: 'dismissed', reviewedAt: r.updatedAt});
    r.events.push(newEvent('shot', 60000));
    applyMatchScan(r, input);
    assert.deepEqual(r.events.map(e => e.kind), ['goal', 'cut', 'shot']);
    assert.equal(footballStats(r.events).goal, 1);
    assert.equal(footballStats(r.events).cut, 0);
    const imported = validateReport(JSON.parse(JSON.stringify(r)));
    assert.equal(sessionKey(imported), 'youtube:' + id);
    assert.match(vtt(imported), /Goal · Blue · 4/);
    assert.doesNotMatch(vtt(imported), /View change/);
    assert.throws(() => applyMatchScan(r, scan(ids.find(other => other !== id), [])), /match/);
    const bad = scan(id, [marker(91000)]);
    assert.throws(() => applyMatchScan(r, bad), /invalid/);
    assert.deepEqual(r.events.map(e => e.kind), ['goal', 'cut', 'shot']);
  }
});

test('links return to an approved studio and the analyser accepts only supported private origins', () => {
  const firebase = 'https://chalachitram-42da6--football-abcd.web.app';
  assert.equal(studioOrigin(firebase), firebase);
  assert.equal(studioOrigin('https://unrelated.web.app'), null);
  assert.equal(analyserOrigin('https://8080-example.cloudshell.dev/'), 'https://8080-example.cloudshell.dev');
  assert.equal(analyserOrigin('https://fakecloudshell.dev'), null);
  assert.equal(analyserOrigin('https://preview.cloudshell.dev.evil.test'), null);
  assert.equal(analyserOrigin('https://secret@preview.cloudshell.dev/'), null);
  assert.equal(studioOrigin('https://x.cloudshell.dev'), null);
  assert.equal(analyserOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => validateScan(scan(ids[0], []), null));
});

test('FFmpeg match worker decodes real media and rejects metadata that would truncate reported coverage', async t => {
  if (spawnSync('ffmpeg', ['-version']).error) return t.skip('FFmpeg not available');
  const path = fileURLToPath(new URL('../public/assets/court.mp4', import.meta.url));
  const r = await analyseFile(path, 10000, 'ffmpeg');
  assert.equal(r.samples, 20);
  assert.equal(r.engine, FOOTBALL_ENGINE);
  assert.equal(r.stepSeconds, 0.5);
  assert(r.moments.every(m => ['activity', 'cut'].includes(m.kind)));
  await assert.rejects(analyseFile(path, 90000, 'ffmpeg'), /ended early/);
});

test('the embedded player uses a real iframe, preserves referral, propagates seeking, time, errors and cleanup', async t => {
  const iframe = {};
  let apiArgs, instance, destroyed = 0, pause = 0, played = 0, sought = -1;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({title:'Example match'})));
  globalThis.location = {origin: 'https://example.test'};
  globalThis.document = {createElement: () => iframe};
  globalThis.window = {YT:{Player: class {
    constructor(frame, opts) { assert.equal(frame, iframe); apiArgs = opts; instance = this; }
    getDuration() { return 2929; } getCurrentTime() { return 47.25; }
    seekTo(s) { sought = s; } playVideo() { played++; } pauseVideo() { pause++; } destroy() { destroyed++; }
  }}};
  t.after(() => { delete globalThis.location; delete globalThis.document; delete globalThis.window; });
  const host = {replaceChildren(...els) { this.children = els; }};
  const info = [], errors = [];
  const remote = openYouTube(host, ids[0], item => info.push(item), e => errors.push(e));
  remote.seek(11);
  assert.equal(remote.time(), null);
  await new Promise(resolve => setImmediate(resolve));
  assert(instance);
  assert.equal(new URL(iframe.src).hostname, 'www.youtube-nocookie.com');
  assert.equal(new URL(iframe.src).searchParams.get('origin'), location.origin);
  assert.equal(iframe.referrerPolicy, 'strict-origin-when-cross-origin');
  apiArgs.events.onReady();
  assert.equal(sought, 11);
  assert.equal(remote.time(), 47.25);
  assert(info.some(i => i.duration === 2929) && info.some(i => i.title === 'Example match'));
  remote.play(); remote.pause(); apiArgs.events.onError();
  assert.equal(played, 1); assert.equal(pause, 1); assert.equal(errors.length, 1);
  remote.destroy();
  assert.equal(destroyed, 1); assert.equal(host.children.length, 0);
  const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url))).hosting;
  const csp = config.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com;/);
});

test('audio scan locates a short high whistle and ignores lower notes, silence and a continuous tone', async () => {
  const {WhistleScanner} = await import('../scripts/match_audio.mjs');
  const scanner = new WhistleScanner(), rate = 12000;
  const total = rate * 8;
  for (let start = 0; start + 512 <= total; start += 512) {
    const block = Buffer.alloc(1024);
    for (let j = 0; j < 512; j++) {
      const t = (j + start) / rate;
      const hz = t >= 1 && t < 1.5 ? 3010 : t >= 2 && t < 2.5 ? 440 : t >= 3 && t < 7 ? 2500 : 0;
      block.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * t)), j * 2);
    }
    scanner.push(block);
  }
  const [w, ...others] = scanner.finish(8000);
  assert.deepEqual(others, []);
  assert(Math.abs(w.startMs - 1000) < 60);
  assert(Math.abs(w.endMs - 1500) < 60);
  assert(Math.abs(w.frequencyHz - 3010) < 25);
  const r = newReport(source(ids[0]), 'football');
  const result = {...scan(ids[0], []), audioScanned:true, whistles:[w]};
  applyMatchScan(r, result);
  const firstId = r.events[0].id;
  applyMatchScan(r, scan(ids[0], [])); // A later visual-only run keeps the sound evidence.
  assert.equal(r.events[0].id, firstId);
  assert.equal(r.events[0].kind, 'whistle');
  assert.match(r.events[0].evidence, /Hz/);
  assert.equal(footballStats(r.events).foul, 0);
  Object.assign(r.events[0], {kind:'foul', original:{kind:'whistle',startMs:w.startMs,endMs:w.endMs},
    status:'confirmed', reviewedAt:r.updatedAt});
  applyMatchScan(r, result);
  assert.equal(r.events.length, 1);
  assert.equal(footballStats(validateReport(r).events).foul, 1);
});

test('private web page posts a same-origin job and returns timestamped evidence in the Firebase URL fragment', async t => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {hidden:true, disabled:false});
    return elements.get(id);
  };
  const studio = 'https://chalachitram-42da6--football-example.web.app';
  const nonce = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const result = {...scan(ids[1], [marker(78500)]), audioScanned:false, whistles:[]};
  const job = 'a'.repeat(32), calls = [];
  globalThis.document = {getElementById: get};
  globalThis.location = {origin: 'https://8080-example.cloudshell.dev',
    hash:'#' + new URLSearchParams({video:ids[1],request:nonce,studio})};
  t.after(() => { delete globalThis.document; delete globalThis.location; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify(url === '/api/jobs' ? {job} : {state:'done', message:'Complete', result}));
  });
  await import('../public/match-connect.js?test');
  assert.equal(get('run').hidden, false);
  await get('run').onclick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].headers['X-ChalaChitra'], 'match');
  assert.deepEqual(JSON.parse(calls[0][1].body), {video:ids[1],request:nonce});
  const link = new URL(get('result').href);
  assert.equal(link.origin, studio);
  assert.equal(link.search, '');
  const returned = JSON.parse(new URLSearchParams(link.hash.slice(1)).get('matchResult'));
  assert.equal(returned.request, nonce);
  assert.deepEqual(validateScan(returned, ids[1]).moments, result.moments);
});
