import {
  MAX_BYTES,
  MAX_EVENTS,
  MAX_REPORT_BYTES,
  digest,
  displayTitle,
  drafts,
  newEvent,
  newReport,
  now,
  parseTime,
  sessionKey,
  timeLabel,
  totals,
  validateReport,
  vtt,
  youtubeId
} from './session.js';
import {
  scanBasketball,
  scanViolin
} from './analysis.js';
import {footballKinds, frameStep} from './football.js';
import {analyserAddress, applyMatchScan, footballStats, studioOrigin} from './football-report.js';
import {scanFootballFile} from './football-scan.js';
import {openYouTube} from './youtube-player.js';
const $ = id => document.getElementById(id);
const media = $('media'),
  stage = $('stage');
const samples = {
  court: {
    file: 'court.mp4',
    name: 'Court practice.mp4',
    mode: 'basketball',
    type: 'video/mp4',
    hash: 'd8fff2a965e4a6de72804c1f73ed1ab6c42363f1204966ba7080b0dee8a1f5de'
  },
  sa: {
    file: 'held-sa.wav',
    name: 'Held Sa exercise.wav',
    mode: 'violin',
    type: 'audio/wav',
    hash: 'e2f245b5f706bfa27d339fa1b06e701363ca4e8203e9c56bc16850bafcabfc4c'
  }
};
let report = null,
  blob = null,
  mediaURL = '',
  filter = 'all',
  editing = null,
  calibration = null,
  job = null;
let youtube = null, remoteNotice = '', privateAnalyser = '';
try { privateAnalyser = analyserAddress(localStorage.getItem('chalachitra.analyser')) || ''; } catch {}
const modeLabels = {football: 'Football', basketball: 'Basketball', violin: 'Carnatic violin'};
const modeIcon = mode => mode === 'violin' ? 'music' : mode === 'football' ? 'film' : 'ball';
let cursor = 0,
  openGeneration = 0,
  saveGeneration = 0,
  writeQueue = Promise.resolve(),
  timer, attachNext = false,
  storageFailed = false;
const el = (tag, cls, content) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg',
    svg = document.createElementNS(ns, 'svg'),
    use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', './icons.svg#' + name);
  svg.append(use);
  return svg;
}

function setIcon(button, name, label) {
  button.replaceChildren(icon(name));
  button.setAttribute('aria-label', label);
  button.title = label;
}
const sampleOf = r => r && Object.values(samples).find(s => s.hash === r.source.sha256);
const statusText = s => ({
  proposed: 'To review',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed'
} [s]);

function say(msg) {
  clearTimeout(timer);
  $('toast').textContent = msg;
  $('toast').hidden = false;
  timer = setTimeout(() => $('toast').hidden = true, 4500);
}

function setDraft(msg, warning = false) {
  $('draftState').textContent = msg;
  $('draftDot').classList.toggle('warn', warning);
}

function save(touch = true) {
  if (!report) return;
  if (touch) report.updatedAt = now();
  const r = structuredClone(report),
    key = sessionKey(r),
    generation = ++saveGeneration;
  try {
    localStorage.setItem('chalachitra.last', key);
  } catch {}
  setDraft('Saving local draft…');
  writeQueue = writeQueue.catch(() => {}).then(() => drafts('put', key, r)).then(() => {
    if (generation === saveGeneration) {
      storageFailed = false;
      setDraft('Draft saved on this device');
    }
  }).catch(err => {
    if (generation === saveGeneration) {
      storageFailed = true;
      setDraft(err.name === 'DraftConflictError' ? 'Newer draft in another tab · export this copy' :
        'Draft storage unavailable · export JSON to save', true);
    }
  });
}

function close(id) {
  if ($(id).open) $(id).close();
}

function show(id) {
  if (!$(id).open) $(id).showModal();
}

function safely(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err.name !== 'AbortError') say(err.message || 'The operation could not finish.');
    }
  };
}

function canLeave() {
  return !storageFailed || confirm('This draft could not be saved here. Open another session anyway?');
}

function stopJob() {
  if (job) job.abort();
  job = null;
  $('job').hidden = true;
}

function setSource(r, file = null, url = '') {
  stopJob();
  calibration = null;
  filter = 'all';
  editing = null;
  cursor = 0;
  youtube?.destroy();
  youtube = null;
  remoteNotice = '';
  media.pause();
  media.removeAttribute('src');
  media.removeAttribute('poster');
  media.load();
  if (mediaURL && mediaURL !== url) URL.revokeObjectURL(mediaURL);
  report = r;
  blob = file;
  mediaURL = url;
  if (url) {
    media.src = url;
    media.load();
  }
  if (!url && r.source.youtubeId && r.mode === 'football') mountMatchPlayer(r);
  $('analysisMessage').textContent = '';
  render();
  save(false);
}

function mountMatchPlayer(r) {
  youtube = openYouTube($('youtubePlayer'), r.source.youtubeId, info => {
    if (report !== r) return;
    let changed = false;
    if (info.title && info.title !== r.source.name) { r.source.name = info.title; changed = true; }
    const ms = Math.round((info.duration || 0) * 1000);
    if (ms > 0 && ms <= 86400000 && !r.footballScan && ms !== r.source.durationMs && r.events.every(e => e.endMs <= ms)) {
      r.source.durationMs = ms;
      changed = true;
    }
    if (changed) { save(); render(); }
  }, message => {
    if (report !== r) return;
    remoteNotice = message;
    updatePlayer();
  });
}

function metadata(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const finish = (fn, arg) => {
      clearTimeout(timeout);
      v.onloadedmetadata = v.onerror = null;
      v.removeAttribute('src');
      v.load();
      fn(arg);
    };
    const timeout = setTimeout(() => finish(reject, new Error(
      'Reading the recording timed out. Try a shorter MP4 or WAV.')), 12000);
    v.onerror = () => finish(reject, new Error(
      'This browser cannot play that file. Try MP4, WebM, WAV or M4A.'));
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 86400) return finish(reject,
        new Error('Use a recording with a known duration under 24 hours.'));
      finish(resolve, {
        durationMs: Math.max(1, Math.round(v.duration * 1000)),
        audio: !v.videoWidth
      });
    };
    v.src = url;
  });
}

function seed(source, mode, sample) {
  const r = newReport(source, mode);
  if (sample === samples.court) {
    r.settings.rim = {
      x: 645 / 960,
      y: 199 / 540,
      width: 44 / 960
    };
    r.events = [
      newEvent('basket', 1900, {
        confidence: {
          event: 'reviewed',
          timing: 'reviewed',
          points: 'unknown',
          team: 'unknown',
          player: 'unknown'
        },
        evidence: 'Authored sample marker. The first simulated throw crosses the rim.'
      }),
      newEvent('note', 4850, {
        title: 'Wide of the rim',
        note: 'The second throw finishes to the right.',
        confidence: {
          event: 'reviewed',
          timing: 'reviewed'
        }
      }),
      newEvent('basket', 8150, {
        status: 'proposed',
        confidence: {
          event: 'medium',
          timing: 'medium',
          points: 'unknown',
          team: 'unknown',
          player: 'unknown'
        },
        evidence: 'Authored practice marker for the final throw. Replay it to confirm or dismiss.'
      })
    ];
  }
  return r;
}
async function openFile(file, {
  sample = null,
  attach = false,
  restore = null
} = {}) {
  if (!file) return;
  if (attach && report?.mode === 'football' && report.source.youtubeId && !report.source.sha256)
    return attachMatchOriginal(file);
  if (file.size > MAX_BYTES) throw new Error('For a full football recording, open its YouTube link first and choose Use original video. Other files support up to 64 MiB.');
  if (!restore && !attach && !canLeave()) return;
  const generation = ++openGeneration,
    url = URL.createObjectURL(file);
  setDraft('Opening recording…');
  try {
    const [meta, hash] = await Promise.all([metadata(url), file.arrayBuffer().then(digest)]);
    if (generation !== openGeneration) {
      URL.revokeObjectURL(url);
      return;
    }
    if (sample && hash !== sample.hash) throw new Error('The sample could not be verified. Reload the studio.');
    if (attach && report.source.sha256 && hash !== report.source.sha256) throw new Error(
      'This file does not match the report. Choose the original recording.');
    const retained = restore || (report?.source.sha256 === hash || attach ? report : null);
    if (retained && retained.source.sha256 && retained.source.sha256 !== hash) throw new Error(
      'The recording fingerprint does not match.');
    if (retained && retained.events.some(e => e.endMs > meta.durationMs)) throw new Error(
      'This recording ends before the last saved event.');
    await writeQueue;
    const stored = retained || await drafts('get', hash).catch(() => null);
    if (generation !== openGeneration) {
      URL.revokeObjectURL(url);
      return;
    }
    const source = {
      name: file.name.slice(0, 255),
      sha256: hash,
      youtubeId: stored?.source.youtubeId || null,
      durationMs: meta.durationMs
    };
    const r = stored ? validateReport(structuredClone(stored)) : seed(source, sample?.mode || (meta.audio ?
      'violin' : 'basketball'), sample);
    r.source = source;
    setSource(r, file, url);
    close('openDialog');
    close('sessionsDialog');
  } catch (err) {
    URL.revokeObjectURL(url);
    if (generation === openGeneration) setDraft(report ? 'Current session retained' : 'Choose another recording',
      true);
    throw err;
  }
}
async function attachMatchOriginal(file) {
  const target = report, generation = ++openGeneration, url = URL.createObjectURL(file);
  try {
    const info = await metadata(url);
    if (info.audio) throw new Error('Choose a video file for football analysis.');
    frameStep(info.durationMs / 1000);
    if (target.source.durationMs && Math.abs(target.source.durationMs - info.durationMs) > 3000)
      throw new Error('The duration differs from this YouTube match. Choose the same edit.');
    if (target.events.some(e => e.endMs > info.durationMs)) throw new Error('This file ends before a saved event.');
    const size = 65536, middle = Math.floor(file.size / 2);
    const fingerprint = await digest(await new Blob([String(file.size), file.slice(0, size),
      file.slice(middle, middle + size), file.slice(-size)]).arrayBuffer());
    if (target.footballFileSignature && target.footballFileSignature !== fingerprint)
      throw new Error('This file differs from the original previously attached to this match.');
    if (generation !== openGeneration || report !== target) { URL.revokeObjectURL(url); return; }
    target.footballFileSignature = fingerprint;
    if (target.source.name === 'YouTube · ' + target.source.youtubeId) target.source.name = file.name.slice(0, 255);
    target.source.durationMs = info.durationMs;
    setSource(target, file, url);
    close('openDialog');
  } catch (err) { URL.revokeObjectURL(url); throw err; }
}

async function openSample(s, restore = null) {
  if (!canLeave()) return;
  const generation = ++openGeneration;
  const resp = await fetch('./assets/' + s.file);
  if (!resp.ok) throw new Error('The sample is unavailable. Open a local recording.');
  const bytes = await resp.blob();
  if (generation !== openGeneration) return;
  await openFile(new File([bytes], s.name, {
    type: s.type
  }), {
    sample: s,
    restore
  });
}

function chooseFile(attach) {
  attachNext = attach;
  $('fileInput').value = '';
  $('fileInput').click();
}
async function openSaved(r) {
  validateReport(r);
  if (!canLeave()) return;
  const s = sampleOf(r);
  if (s) {
    await openSample(s, r);
    return;
  }
  ++openGeneration;
  const sameFile = r.source.sha256 && r.source.sha256 === report?.source.sha256;
  const sameOriginal = r.footballFileSignature && r.footballFileSignature === report?.footballFileSignature &&
    r.source.youtubeId === report.source.youtubeId;
  if (blob && (sameFile || sameOriginal)) setSource(r, blob, mediaURL);
  else setSource(r);
  close('sessionsDialog');
}
async function loadReport(file) {
  if (!file) return;
  if (file.size > MAX_REPORT_BYTES) throw new Error('Choose a JSON report under 16 MiB.');
  let r;
  try {
    r = JSON.parse(await file.text());
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  validateReport(r);
  await writeQueue;
  const stored = await drafts('get', sessionKey(r)).catch(() => null);
  if (stored && JSON.stringify(stored) !== JSON.stringify(r) && !confirm(
      'Replace the local draft for this recording with the imported report?')) return;
  await openSaved(r);
  say(mediaURL || youtube ? 'Report restored.' : 'Report restored. Attach the matching recording to replay it.');
}

function saveDownload(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], {
      type
    })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportReport(format) {
  if (!report) return;
  const name = report.source.name.replace(/\.[\w]{1,6}$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80) ||
    'recording';
  const json = format === 'json';
  saveDownload(name + (json ? '.chalachitra.json' : '.vtt'), json ? JSON.stringify(report, null, 2) + '\n' : vtt(
    report), json ? 'application/json' : 'text/vtt');
  close('exportDialog');
  say(json ? 'JSON report exported.' : 'WebVTT captions exported.');
}

function currentMs() {
  if (mediaURL) return Math.round((media.currentTime || 0) * 1000);
  const seconds = youtube?.time();
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : cursor;
}

function seek(ms) {
  cursor = Math.min(report?.source.durationMs || 86400000, Math.max(0, ms));
  if (mediaURL && media.readyState >= 1) {
    try {
      media.currentTime = cursor / 1000;
    } catch {}
  }
  youtube?.seek(cursor / 1000);
  updateTime();
}

function updateTime() {
  if (!report) return;
  const ms = currentMs(),
    dur = report.source.durationMs;
  const active = report.events.reduce((latest, event) => {
    const ends = event.endMs > event.startMs ? event.endMs : event.startMs + 1250;
    if (event.status === 'dismissed' || ms < event.startMs || ms >= ends) return latest;
    return !latest || event.startMs > latest.startMs ? event : latest;
  }, null);
  const caption = $('eventCaption');
  caption.hidden = !active || !mediaURL || !!calibration;
  if (!caption.hidden) {
    const label = [active.status === 'proposed' ? 'To review' : '', displayTitle(active),
      active.points ? active.points + ' pt' : '', active.measurement ? signed(active.measurement.cents) +
      ' cents' : ''
    ].filter(Boolean).join(' · ');
    if (caption.textContent !== label) caption.textContent = label;
  }
  $('playTime').textContent = timeLabel(ms);
  $('totalTime').textContent = dur ? timeLabel(dur) : '—';
  $('scrub').value = String(dur ? Math.min(1000, Math.round(ms / dur * 1000)) : 0);
  if (report.source.youtubeId) {
    const link = 'https://www.youtube.com/watch?v=' + report.source.youtubeId + '&t=' + Math.floor(ms / 1000) + 's';
    $('youtubeGo').href = link;
    $('watchMatch').href = link;
  }
}

function videoBox() {
  const w = stage.clientWidth,
    h = stage.clientHeight,
    ratio = media.videoWidth && media.videoHeight ? media.videoWidth / media.videoHeight : 16 / 9;
  const width = Math.min(w, h * ratio),
    height = width / ratio;
  return {
    x: (w - width) / 2,
    y: (h - height) / 2,
    w: width,
    h: height
  };
}

function drawRim() {
  const r = report?.settings.rim,
    box = videoBox(),
    o = $('rimOverlay');
  o.hidden = !r || !mediaURL || report.mode !== 'basketball' || !!calibration || !media.videoWidth;
  if (o.hidden) return;
  const w = Math.max(20, r.width * box.w * 1.42),
    h = Math.max(12, w * .47);
  Object.assign(o.style, {
    left: (box.x + r.x * box.w - w / 2) + 'px',
    top: (box.y + r.y * box.h - h / 2) + 'px',
    width: w + 'px',
    height: h + 'px'
  });
}

function updatePlayer() {
  const r = report;
  if (!r) return;
  const audio = mediaURL && (blob?.type.startsWith('audio/') || media.readyState >= 1 && !media.videoWidth);
  $('audioArt').hidden = !audio;
  $('audioName').textContent = sampleOf(r) === samples.sa ? 'Held Sa · 220 Hz' : 'Audio recording';
  $('centerPlay').hidden = !mediaURL || !media.paused || !!calibration;
  $('missingMedia').hidden = !!mediaURL || !!youtube;
  $('youtubePlayer').hidden = !youtube;
  $('transport').hidden = !!youtube;
  $('stageBadge').hidden = !!youtube;
  $('linkActions').hidden = !r.source.youtubeId || r.mode !== 'football';
  $('playerNotice').textContent = remoteNotice;
  $('playerNotice').hidden = !remoteNotice;
  $('missingText').textContent = r.source.sha256 ? 'Attach the original recording to replay this report.' :
    'Bookmark the reference by entering event times, or attach the original recording.';
  $('youtubeGo').hidden = !r.source.youtubeId;
  $('calOverlay').hidden = !calibration;
  $('calCursor').hidden = !calibration?.cursor;
  $('calPrompt').textContent = calibration?.first ? 'Tap the other edge of the rim' : 'Tap one edge of the rim';
  $('stageBadge').replaceChildren(icon(modeIcon(r.mode)), el('span', '', modeLabels[r.mode]));
  setIcon($('playBtn'), media.paused ? 'play' : 'pause', media.paused ? 'Play' : 'Pause');
  setIcon($('volumeBtn'), media.muted ? 'mute' : 'volume', media.muted ? 'Unmute' : 'Mute');
  for (const id of ['playBtn', 'speedBtn', 'volumeBtn']) $(id).disabled = !mediaURL;
  $('fullBtn').disabled = !mediaURL || !(document.fullscreenEnabled || media.webkitEnterFullscreen);
  $('scrub').disabled = !r.source.durationMs;
  $('speedBtn').textContent = media.playbackRate + '×';
  drawRim();
  updateTime();
}

function renderEvents() {
  const all = report.events.slice().sort((a, b) => a.startMs - b.startMs);
  $('eventCount').textContent = all.length;
  const sorted = all.filter(e => filter === 'all' || e.status === filter);
  const list = $('events');
  list.replaceChildren();
  if (!sorted.length) list.append(el('div', 'empty', all.length ? 'No events in this filter.' :
    'Add a timestamped event or run an analysis to start the timeline.'));
  for (const e of sorted) {
    const row = el('button', 'eventrow');
    row.type = 'button';
    row.dataset.event = e.id;
    row.setAttribute('aria-label', 'Review ' + displayTitle(e) + ' at ' + timeLabel(e.startMs, true));
    const b = el('span', 'evbody'),
      badges = el('span', 'badges');
    b.append(el('strong', '', displayTitle(e)));
    const details = e.kind === 'basket' ? [e.points ? e.points + ' pt' : 'Points unknown', e.team, e.player]
      .filter(Boolean).join(' · ') :
      Object.hasOwn(footballKinds, e.kind) ? [e.team, e.player, e.note].filter(Boolean).join(' · ') :
      e.measurement ? e.measurement.hz.toFixed(1) + ' Hz · ' + signed(e.measurement.cents) + ' cents' : e.note;
    if (details) b.append(el('small', '', details));
    badges.append(el('span', 'status ' + e.status, statusText(e.status)));
    b.append(badges);
    row.append(el('span', 'etime', timeLabel(e.startMs, true).slice(0, -2)), b, icon('right'));
    row.onclick = () => {
      media.pause();
      youtube?.pause();
      seek(e.startMs);
      edit(e);
    };
    list.append(row);
  }
  $('tickTrack').replaceChildren();
  if (report.source.durationMs)
    for (const e of all.filter(e => e.status !== 'dismissed')) {
      const tick = el('i');
      tick.style.left = (100 * e.startMs / report.source.durationMs) + '%';
      $('tickTrack').append(tick);
    }
  const pending = all.filter(e => e.status === 'proposed').length;
  $('eventFoot').textContent = pending === 1 ? '1 event needs review' : pending ? pending + ' events need review' :
    'All events reviewed';
  for (const btn of document.querySelectorAll('[data-filter]')) btn.setAttribute('aria-pressed', String(btn.dataset
    .filter === filter));
}

function signed(value) {
  const n = Math.round(value);
  return (n > 0 ? '+' : '') + n;
}

function summary() {
  const r = report,
    t = totals(r.events),
    mus = r.mode === 'violin';
  const pitches = r.events.filter(e => e.kind === 'pitch' && e.status === 'confirmed' && e.measurement);
  const football = r.mode === 'football';
  const stats = football ? footballStats(r.events) : null;
  const metrics = football ? [[stats.goal, 'Tagged goals'], [stats.shot, 'Tagged shots'], [t.pending, 'To review']] : mus ? [
    [pitches.length, 'Reviewed notes'],
    [pitches.length ? Math.round(pitches.reduce((n, e) => n + Math.abs(e.measurement.cents), 0) / pitches
      .length) : '—', 'Mean |cents|'],
    [t.pending, 'To review']
  ] : [
    [t.baskets, 'Reviewed baskets'],
    [t.points, 'Known points'],
    [t.pending, 'To review']
  ];
  $('numbers').replaceChildren(...metrics.map(([v, label]) => {
    const n = el('div', 'metric');
    n.append(el('strong', '', v), el('small', '', label));
    return n;
  }));
  $('summaryNote').textContent = football ? 'Counts use confirmed tags. A goal and a shot are separate tags.' : mus ? 'Pitch totals use confirmed held notes.' : t.unknown ? t.unknown +
    ' confirmed ' + (t.unknown === 1 ? 'basket has' : 'baskets have') + ' an unknown point value.' :
    'Points use confirmed baskets with a reviewed value.';
  const bd = $('breakdown');
  bd.replaceChildren();
  if (football) {
    const other = ['save', 'corner', 'foul', 'pass', 'whistle'].filter(k => stats[k]).map(k => footballKinds[k] + ' · ' + stats[k]);
    if (other.length) bd.append(el('p', '', other.join('   /   ')));
    return;
  }
  if (mus) return;
  const groups = new Map();
  for (const e of r.events.filter(e => e.kind === 'basket' && e.status === 'confirmed')) {
    for (const [kind, key] of [
        ['Team', e.team],
        ['Player', e.player && (e.team ? e.team + ' / ' : '') + e.player]
      ]) {
      if (!key) continue;
      const id = kind + ' ' + key,
        record = groups.get(id) || [kind, key, 0, 0];
      record[2]++;
      record[3] += e.points || 0;
      groups.set(id, record);
    }
  }
  if (groups.size) {
    const table = el('table'),
      head = el('tr');
    for (const t of ['Group', 'Name', 'Makes', 'Known pts']) head.append(el('th', '', t));
    table.append(head);
    for (const data of groups.values()) {
      const tr = el('tr');
      for (const text of data) tr.append(el('td', '', text));
      table.append(tr);
    }
    bd.append(table);
  }
}

function render() {
  if (!report) return;
  const r = report,
    s = sampleOf(r),
    music = r.mode === 'violin';
  $('clipName').textContent = r.source.name.replace(/\.(mp4|mov|webm|wav|m4a|mp3|ogg)$/i, '');
  $('clipMeta').textContent = s ? (s === samples.court ? 'Simulated drill · Fixed camera' :
      'Synthesised exercise · Solo pitch') :
    (r.source.sha256 ? 'Local recording' : r.mode === 'football' ? (blob ? 'Original video attached' : 'YouTube match') : 'YouTube reference') + (r.source.durationMs ? ' · ' + timeLabel(r.source
      .durationMs) : '');
  $('sourceTag').hidden = false;
  $('sourceTag').textContent = s ? 'Demo clip' : blob || r.source.sha256 ? 'Local file' : 'YouTube';
  const football = r.mode === 'football';
  $('footballTools').hidden = !football;
  $('footballMode').setAttribute('aria-pressed', String(football));
  $('sportTools').hidden = r.mode !== 'basketball';
  $('musicTools').hidden = !music;
  $('sportMode').setAttribute('aria-pressed', String(r.mode === 'basketball'));
  $('musicMode').setAttribute('aria-pressed', String(music));
  $('saInput').value = r.settings.saHz;
  $('targetInput').value = r.settings.target;
  $('hzInput').value = r.settings.customHz;
  $('customTarget').hidden = r.settings.target !== 'Custom';
  $('rimState').textContent = r.settings.rim ? '✓ Rim marked' : 'Rim required';
  $('markRim').replaceChildren(icon('target'), document.createTextNode(calibration ? 'Cancel marking' : r.settings
    .rim ? 'Adjust rim' : 'Mark rim'));
  const unavailable = !blob || r.source.durationMs > 60050 || !!job;
  $('scanSport').disabled = unavailable || blob?.type.startsWith('audio/');
  $('scanMusic').disabled = unavailable;
  $('markRim').disabled = !blob || blob.type.startsWith('audio/') || !!job;
  $('scanMatch').disabled = !!job || (!r.source.youtubeId && !blob) || (!!blob && blob.type.startsWith('audio/'));
  $('matchOriginal').disabled = !!job || (!r.source.youtubeId && !r.source.sha256);
  $('pairSettings').hidden = !r.source.youtubeId;
  const suggested = analyserAddress($('pairOrigin').value);
  $('pairState').textContent = suggested && suggested !== privateAnalyser ? 'Save this address to use it for your match.' :
    privateAnalyser ? 'Private analyser address saved on this device.' : '';
  const scan = r.footballScan;
  $('matchScanInfo').textContent = football && scan ? 'Last scan sampled ' + scan.samples + ' frames, one every ' + scan.stepSeconds + ' s.' + (scan.audioScanned ? ' Audio has also been scanned for whistles.' : '') : '';
  if (!football && !job && !$('analysisMessage').textContent && (!blob || r.source.durationMs > 60050)) $('analysisMessage')
    .textContent = !blob ? 'Attach a recording for automatic analysis.' :
    'Automatic analysis supports clips up to 60 seconds. Manual review is available.';
  updatePlayer();
  renderEvents();
  summary();
}

function changeMode(mode) {
  if (!report || report.mode === mode) return;
  stopJob();
  calibration = null;
  report.mode = mode;
  if (!mediaURL && report.source.youtubeId) {
    youtube?.destroy();
    youtube = null;
    remoteNotice = '';
    if (mode === 'football') mountMatchPlayer(report);
  }
  $('analysisMessage').textContent = '';
  save();
  render();
}

function startRim() {
  if (!media.videoWidth) {
    say('Open a video and wait for it to load.');
    return;
  }
  media.pause();
  calibration = calibration ? null : {
    first: null
  };
  render();
  if (calibration) {
    stage.scrollIntoView({
      block: 'nearest'
    });
    $('calOverlay').focus();
  }
}

function markRimPoint(x, y) {
  const b = videoBox();
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    say('Choose a point inside the video frame.');
    return;
  }
  if (!calibration.first) {
    calibration.first = {
      x,
      y
    };
    updatePlayer();
    return;
  }
  const first = calibration.first,
    width = Math.abs(x - first.x);
  if (width < .012 || width > .8 || Math.abs(y - first.y) * b.h > Math.max(12, width * b.w * .55)) {
    say('Choose opposite edges along the same rim.');
    calibration = {
      first: null
    };
    updatePlayer();
    return;
  }
  report.settings.rim = {
    x: (x + first.x) / 2,
    y: (y + first.y) / 2,
    width
  };
  calibration = null;
  save();
  render();
  say('Rim calibration saved.');
}
$('calOverlay').onclick = e => {
  if (!calibration) return;
  const rect = stage.getBoundingClientRect(),
    b = videoBox();
  markRimPoint((e.clientX - rect.left - b.x) / b.w, (e.clientY - rect.top - b.y) / b.h);
};
$('calOverlay').onkeydown = e => {
  if (!calibration) return;
  const point = calibration.cursor || {
    x: report.settings.rim?.x ?? .5,
    y: report.settings.rim?.y ?? .5
  };
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    markRimPoint(point.x, point.y);
    return;
  }
  const moves = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  };
  if (!moves[e.key]) return;
  e.preventDefault();
  const [dx, dy] = moves[e.key], b = videoBox(), step = e.shiftKey ? 10 : 1;
  point.x = Math.min(1, Math.max(0, point.x + dx * step / b.w));
  point.y = Math.min(1, Math.max(0, point.y + dy * step / b.h));
  calibration.cursor = point;
  const cross = $('calCursor');
  cross.hidden = false;
  cross.style.left = (b.x + point.x * b.w) + 'px';
  cross.style.top = (b.y + point.y * b.h) + 'px';
};

function readMusicSettings() {
  const sa = Number($('saInput').value),
    hz = Number($('hzInput').value);
  if (!Number.isFinite(sa) || sa < 50 || sa > 1000 || !Number.isFinite(hz) || hz < 50 || hz > 1600)
    throw new Error('Enter Sa between 50 and 1000 Hz and a custom target between 50 and 1600 Hz.');
  report.settings.saHz = sa;
  report.settings.customHz = hz;
  report.settings.target = $('targetInput').value;
  $('customTarget').hidden = report.settings.target !== 'Custom';
  save();
}

function similar(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'basket') return Math.abs(a.startMs - b.startMs) < 450;
  return Math.abs((a.measurement?.targetHz || 0) - (b.measurement?.targetHz || 0)) < .1 &&
    Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs) > .5 * Math.min(a.endMs - a.startMs, b.endMs - b
      .startMs);
}
async function analyse() {
  if (!report || !blob || job) return;
  if (report.source.durationMs > 60050) throw new Error('Choose a recording up to 60 seconds for analysis.');
  const sport = report.mode === 'basketball';
  if (sport && !report.settings.rim) {
    startRim();
    $('analysisMessage').textContent = 'Mark both rim edges, then choose Analyse clip.';
    return;
  }
  if (!sport) readMusicSettings();
  calibration = null;
  media.pause();
  const control = new AbortController();
  job = control;
  $('analysisMessage').textContent = sport ? 'Following motion near the rim…' :
    'Measuring stable pitch intervals…';
  $('jobBar').value = 0;
  $('job').hidden = false;
  render();
  const progress = n => {
    if (job === control) $('jobBar').value = Math.min(1, n);
  };
  try {
    const found = sport ? await scanBasketball(mediaURL, report.settings.rim, control.signal, progress) :
      await scanViolin(blob, report.settings, control.signal, progress);
    if (job !== control) return;
    const kind = sport ? 'basket' : 'pitch';
    const old = report.events.filter(e => e.kind === kind && e.origin === 'analysis' && e.status ===
      'proposed' && !e.reviewedAt);
    const keep = report.events.filter(e => !old.includes(e));
    let added = 0;
    for (const e of found) {
      if (keep.some(q => similar(e, q) || q.original && similar(e, q.original))) continue;
      if (keep.length >= MAX_EVENTS) throw new Error('The report is full. Export your existing annotations.');
      const prior = old.find(q => similar(e, q));
      if (prior) e.id = prior.id;
      else added++;
      keep.push(e);
    }
    report.events = keep;
    save();
    filter = 'all';
    $('analysisMessage').textContent = found.length ? found.length + ' candidate' + (found.length === 1 ? '' :
        's') + ' detected · ' + added + ' new suggestions.' :
      sport ? 'No clear rim crossings detected. Mark the rim again or add a basket manually.' :
      'No stable held notes detected. Try a quieter, solo recording.';
  } catch (err) {
    if (job === control) $('analysisMessage').textContent = err.name === 'AbortError' ? 'Analysis cancelled.' :
      err.message;
  } finally {
    if (job === control) {
      job = null;
      $('job').hidden = true;
      render();
    }
  }
}

async function analyseFootball() {
  if (!report || job) return;
  if (!blob) {
    if (!report.source.youtubeId) return chooseFile(true);
    const entered = analyserAddress($('pairOrigin').value);
    if (!privateAnalyser || (entered && entered !== privateAnalyser)) {
      $('pairSettings').open = true;
      $('pairOrigin').focus();
      $('analysisMessage').textContent = 'Save your private analyser address to scan this link, or choose the original video.';
      return;
    }
    if (!studioOrigin(location.origin)) throw new Error('Open the studio at its Firebase preview or localhost address.');
    const target = report;
    await writeQueue;
    if (report !== target) return;
    if (storageFailed) throw new Error('Export this draft, then enable browser storage before leaving for link analysis.');
    const request = crypto.randomUUID();
    sessionStorage.setItem('chalachitra.matchRequest', JSON.stringify({id: target.source.youtubeId, request}));
    const bridge = new URL(privateAnalyser);
    bridge.hash = new URLSearchParams({video: target.source.youtubeId, studio: location.origin, request}).toString();
    location.assign(bridge.href);
    return;
  }
  const control = new AbortController();
  job = control;
  media.pause();
  $('jobBar').value = 0;
  $('job').hidden = false;
  $('analysisMessage').textContent = 'Sampling the recording on this device…';
  render();
  try {
    const result = await scanFootballFile(mediaURL, report.source, control.signal, p => {
      if (job === control) $('jobBar').value = p;
    });
    if (job !== control) return;
    applyMatchScan(report, result);
    save();
    filter = 'all';
    $('analysisMessage').textContent = scanMessage(result);
  } catch (err) {
    if (job === control) $('analysisMessage').textContent = err.name === 'AbortError' ? 'Analysis cancelled.' : err.message;
  } finally {
    if (job === control) { stopJob(); render(); }
  }
}

function scanMessage(result) {
  const visual = result.moments.length;
  const message = visual + ' visual moment' + (visual === 1 ? '' : 's');
  if (result.audioScanned) return message + ' and ' + result.whistles.length + ' whistle-like sounds detected. Review the timeline.';
  const note = result.audioScanned === false ? ' No decodable audio track was available.' : '';
  return (visual ? message + ' detected. Review the timeline.' : 'Scan complete. No distinct motion peaks or view changes met the threshold.') + note;
}

function edit(event = null) {
  if (!report) return;
  if (!event && report.events.length >= MAX_EVENTS) {
    say('The session already has 2000 events.');
    return;
  }
  const at = currentMs();
  media.pause();
  youtube?.pause();
  editing = event?.id || null;
  const e = event || newEvent('note', at);
  const available = {note: 'Observation'};
  if (report.mode === 'football') Object.assign(available, footballKinds);
  else Object.assign(available, {basket: 'Basket', pitch: 'Held note'});
  if (!available[e.kind]) available[e.kind] = footballKinds[e.kind] || displayTitle(e);
  $('eKind').replaceChildren(...Object.entries(available).map(([kind, label]) => {
    const option = el('option', '', label); option.value = kind; return option;
  }));
  $('replayEvent').hidden = !event || (!mediaURL && !youtube);
  $('editTitle').textContent = event ? 'Review event' : 'Add event';
  $('eKind').value = e.kind;
  $('eStatus').value = e.status;
  $('eStart').value = timeLabel(e.startMs, true);
  $('eEnd').value = e.endMs > e.startMs ? timeLabel(e.endMs, true) : '';
  $('eTitle').value = e.title;
  $('eNote').value = e.note;
  $('ePoints').value = e.points ?? '';
  $('eTeam').value = e.team;
  $('ePlayer').value = e.player;
  eventFields(e.kind);
  $('eError').textContent = '';
  const details = [];
  if (e.measurement) details.push(e.measurement.hz.toFixed(2) + ' Hz measured / ' + e.measurement.targetHz.toFixed(
    2) + ' Hz target · ' + signed(e.measurement.cents) + ' cents');
  if (e.evidence) details.push(e.evidence);
  if (e.detector) details.push('Detector: ' + e.detector);
  if (Object.keys(e.confidence).length) details.push('Confidence: ' + Object.entries(e.confidence).map(([k, v]) =>
    k + ' ' + v).join(', '));
  $('eEvidence').textContent = details.join('\n');
  $('eEvidence').hidden = !details.length;
  show('eventDialog');
}
$('replayEvent').onclick = safely(async () => {
  const event = report?.events.find(item => item.id === editing);
  if (!event || (!mediaURL && !youtube)) return;
  close('eventDialog');
  seek(Math.max(0, event.startMs - 750));
  if (youtube) youtube.play();
  else await media.play();
});
$('eventForm').onsubmit = e => {
  e.preventDefault();
  if (!report) return;
  const start = parseTime($('eStart').value),
    end = $('eEnd').value.trim() ? parseTime($('eEnd').value) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > (report.source.durationMs ||
      86400000)) {
    $('eError').textContent = 'Use a time inside the clip, such as 0:02.450. The end must follow the start.';
    return;
  }
  const prior = report.events.find(e => e.id === editing),
    kind = $('eKind').value,
    basket = kind === 'basket',
    teamSport = basket || Object.hasOwn(footballKinds, kind);
  const next = prior ? {
    ...prior,
    confidence: {
      ...prior.confidence
    }
  } : newEvent(kind, start);
  if (prior?.origin === 'analysis' && !next.original) next.original = {
    kind: prior.kind,
    startMs: prior.startMs,
    endMs: prior.endMs,
    confidence: {
      ...prior.confidence
    },
    measurement: prior.measurement ? {
      ...prior.measurement
    } : null
  };
  Object.assign(next, {
    kind,
    startMs: start,
    endMs: end,
    title: $('eTitle').value.trim(),
    note: $('eNote').value.trim(),
    status: $('eStatus').value,
    points: basket && $('ePoints').value ? Number($('ePoints').value) : null,
    team: teamSport ? $('eTeam').value.trim() : '',
    player: teamSport ? $('ePlayer').value.trim() : '',
    reviewedAt: now()
  });
  if (kind !== 'pitch') next.measurement = null;
  if (next.status === 'confirmed') next.confidence.event = 'reviewed';
  if (!prior || prior.startMs !== start || prior.endMs !== end) next.confidence.timing = 'reviewed';
  if (teamSport)
    for (const f of basket ? ['points', 'player', 'team'] : ['player', 'team']) next.confidence[f] = next[f] ? 'reviewed' : 'unknown';
  if (prior) report.events[report.events.indexOf(prior)] = next;
  else report.events.push(next);
  close('eventDialog');
  save();
  render();
  say(prior ? 'Event updated.' : 'Event added.');
};
function eventFields(kind) {
  $('basketFields').hidden = kind !== 'basket' && !Object.hasOwn(footballKinds, kind);
  $('pointsField').hidden = kind !== 'basket';
}
$('eKind').onchange = () => eventFields($('eKind').value);
async function sessionList() {
  await writeQueue;
  const list = $('draftList');
  list.replaceChildren();
  const sessions = await drafts('all');
  for (const r of sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    try {
      validateReport(r);
    } catch {
      continue;
    }
    const btn = el('button'),
      label = el('span');
    label.append(el('strong', '', r.source.name),
      el('small', '', r.events.length + ' events · ' + new Date(r.updatedAt).toLocaleString()));
    btn.append(icon(modeIcon(r.mode)), label, icon('right'));
    btn.onclick = safely(async () => openSaved(await drafts('get', sessionKey(r))));
    list.append(btn);
  }
  if (!list.children.length) list.append(el('p', 'empty', 'No local drafts yet.'));
  show('sessionsDialog');
}
async function matchReport(id) {
  await writeQueue;
  const stored = await drafts('get', 'youtube:' + id).catch(() => null);
  const r = stored ? validateReport(stored) : newReport({name: 'YouTube · ' + id, youtubeId: id, sha256: null, durationMs: 0}, 'football');
  r.mode = 'football';
  return r;
}

$('refForm').onsubmit = safely(async e => {
  e.preventDefault();
  const id = youtubeId($('ytUrl').value.trim());
  if (!id) { $('urlError').textContent = 'Enter a YouTube watch, share, Shorts or live video link.'; return; }
  if (!canLeave()) return;
  const generation = ++openGeneration;
  const r = await matchReport(id);
  if (generation !== openGeneration) return;
  setSource(r);
  close('openDialog');
  $('urlError').textContent = '';
  $('ytUrl').value = '';
});

function openMatchDialog() {
  show('openDialog');
  $('ytUrl').focus();
}
$('openMatchBtn').onclick = openMatchDialog;
$('footballMode').onclick = () => report ? changeMode('football') : openMatchDialog();
$('watchMatch').onclick = updateTime;
$('attachMatch').onclick = $('matchOriginal').onclick = () => chooseFile(true);
$('scanMatch').onclick = safely(analyseFootball);
$('pairOrigin').value = privateAnalyser;
$('pairSave').onclick = () => {
  const value = $('pairOrigin').value.trim();
  const address = analyserAddress(value);
  if (value && !address) { $('pairState').textContent = 'Copy the address from a working Cloud Shell Web Preview or use localhost.'; return; }
  privateAnalyser = address || '';
  try { localStorage.setItem('chalachitra.analyser', privateAnalyser); } catch {}
  $('pairOrigin').value = privateAnalyser;
  render();
  $('analysisMessage').textContent = privateAnalyser ? 'Choose Analyse match to open your private analyser.' : 'Private analyser disconnected.';
};
for (const btn of document.querySelectorAll('[data-close]')) btn.onclick = () => btn.closest('dialog').close();
$('openBtn').onclick = () => show('openDialog');
$('guideBtn').onclick = () => show('guideDialog');
$('sessionsNav').onclick = safely(sessionList);
$('studioNav').onclick = () => {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('studio').scrollIntoView({
    block: 'start'
  });
};
$('pickFile').onclick = () => chooseFile(false);
$('attachBtn').onclick = () => chooseFile(true);
$('fileInput').onchange = safely(() => openFile($('fileInput').files[0], {
  attach: attachNext
}));
$('sampleCourt').onclick = safely(() => openSample(samples.court));
$('sampleSa').onclick = safely(() => openSample(samples.sa));
$('importBtn').onclick = () => {
  $('reportInput').value = '';
  $('reportInput').click();
};
$('reportInput').onchange = safely(() => loadReport($('reportInput').files[0]));
$('exportBtn').onclick = () => report && show('exportDialog');
$('jsonBtn').onclick = () => exportReport('json');
$('vttBtn').onclick = () => exportReport('vtt');
$('sportMode').onclick = () => changeMode('basketball');
$('musicMode').onclick = () => changeMode('violin');
for (const id of ['saInput', 'targetInput', 'hzInput']) $(id).onchange = safely(readMusicSettings);
$('markRim').onclick = startRim;
$('scanSport').onclick = safely(analyse);
$('scanMusic').onclick = safely(analyse);
$('cancelJob').onclick = () => job?.abort();
$('addBtn').onclick = () => edit();
for (const btn of document.querySelectorAll('[data-filter]')) btn.onclick = () => {
  if (report) {
    filter = btn.dataset.filter;
    renderEvents();
  }
};
const togglePlay = safely(async () => {
  if (!mediaURL || calibration) return;
  if (media.paused) {
    if (media.ended) media.currentTime = 0;
    await media.play();
  } else media.pause();
});
$('playBtn').onclick = togglePlay;
$('centerPlay').onclick = togglePlay;
media.onclick = togglePlay;
$('scrub').oninput = () => {
  if (report) seek(Number($('scrub').value) / 1000 * report.source.durationMs);
};
$('volumeBtn').onclick = () => {
  media.muted = !media.muted;
  updatePlayer();
};
$('speedBtn').onclick = () => {
  const speeds = [.5, .75, 1, 1.25, 1.5, 2];
  media.playbackRate = speeds[(speeds.indexOf(media.playbackRate) + 1) % speeds.length];
  updatePlayer();
};
$('fullBtn').onclick = safely(async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else if (document.fullscreenEnabled) await $('playerShell').requestFullscreen();
  else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
});
for (const name of ['loadedmetadata', 'loadeddata', 'play', 'pause', 'ended']) media.addEventListener(name,
  updatePlayer);
media.addEventListener('timeupdate', updateTime);
media.addEventListener('seeked', updateTime);
new ResizeObserver(drawRim).observe(stage);
document.addEventListener('keydown', e => {
  if (!report || e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]') || e.target
    .closest('input,textarea,select,button,a,summary,[contenteditable]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key.toLowerCase() === 'm') {
    e.preventDefault();
    edit();
  } else if (e.key === 'Escape' && calibration) {
    calibration = null;
    render();
  }
});
const wave = document.querySelector('.wave');
for (let i = 0; i < 47; i++) {
  const bar = el('i');
  bar.style.height = (12 + Math.abs(Math.sin(i * 1.17) * Math.cos(i * .27)) * 65) + 'px';
  wave.append(bar);
}
async function init() {
  const hash = location.hash;
  if (hash.startsWith('#analyser=')) {
    const suggested = analyserAddress(new URLSearchParams(hash.slice(1)).get('analyser'));
    if (suggested && suggested !== privateAnalyser) {
      $('pairOrigin').value = suggested;
      $('pairSettings').open = true;
    }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (hash.startsWith('#matchResult=')) {
    try {
      const pending = JSON.parse(sessionStorage.getItem('chalachitra.matchRequest') || 'null');
      if (!pending || hash.length > 45000) throw new Error('Open this match and start a new scan from this tab.');
      const result = JSON.parse(new URLSearchParams(hash.slice(1)).get('matchResult'));
      if (result.videoId !== pending.id || result.request !== pending.request) throw new Error('The scan belongs to a different request.');
      const r = await matchReport(pending.id);
      applyMatchScan(r, result);
      setSource(r);
      $('analysisMessage').textContent = scanMessage(result);
      await writeQueue;
      if (!storageFailed) {
        sessionStorage.removeItem('chalachitra.matchRequest');
        history.replaceState(null, '', location.pathname + location.search);
      }
      return;
    } catch (err) { say(err.message); history.replaceState(null, '', location.pathname + location.search); }
  }
  let last;
  try {
    const key = localStorage.getItem('chalachitra.last');
    if (key) last = await drafts('get', key);
  } catch {}
  if (last) {
    try {
      await openSaved(validateReport(last));
      return;
    } catch {}
  }
  setDraft('Open a match or choose a recording');
  openMatchDialog();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
