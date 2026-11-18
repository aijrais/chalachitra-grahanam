import {
  locateBall,
  basketCrossings,
  SHOT_ENGINE,
  PITCH_ENGINE,
  targetHz
} from './detectors.js';
import {
  newEvent
} from './session.js';
const cancelled = () => new DOMException('Analysis cancelled.', 'AbortError');

function mediaReady(media, event, signal, act) {
  return new Promise((resolve, reject) => {
    const finish = err => {
      clearTimeout(timer);
      media.removeEventListener(event, done);
      media.removeEventListener('error', fail);
      signal.removeEventListener('abort', stop);
      err ? reject(err) : resolve();
    };
    const done = () => finish(),
      fail = () => finish(new Error('This browser could not decode the clip. Try an MP4 recording.')),
      stop = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error(
      'Reading a video frame timed out. Try a shorter MP4 clip.')), 10000);
    media.addEventListener(event, done, {
      once: true
    });
    media.addEventListener('error', fail, {
      once: true
    });
    signal.addEventListener('abort', stop, {
      once: true
    });
    if (signal.aborted) return stop();
    try {
      act();
    } catch (err) {
      finish(err);
    }
  });
}
export async function scanBasketball(url, rim, signal, progress) {
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';
  vid.className = 'analysis-video';
  vid.setAttribute('aria-hidden', 'true');
  document.body.append(vid);
  try {
    await mediaReady(vid, 'loadeddata', signal, () => {
      vid.src = url;
      vid.load();
    });
    if (!vid.videoWidth) throw new Error('Basketball analysis needs a video track.');
    if (!Number.isFinite(vid.duration) || vid.duration > 60.05) throw new Error(
      'Use a clip of 60 seconds or less for automatic analysis.');
    const canvas = document.createElement('canvas'),
      scale = Math.min(1, 400 / Math.max(vid.videoWidth, vid.videoHeight));
    canvas.width = Math.max(1, Math.round(vid.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(vid.videoHeight * scale));
    const ctx = canvas.getContext('2d', {
      willReadFrequently: true
    });
    const samples = [];
    let previous = null,
      last = null,
      lastSeen = -1;
    for (let frame = 0; frame < Math.ceil(vid.duration * 12); frame++) {
      if (signal.aborted) throw cancelled();
      const sec = Math.min(frame / 12, vid.duration - .001);
      if (frame > 0) await mediaReady(vid, 'seeked', signal, () => {
        vid.currentTime = sec;
      });
      ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hit = locateBall(pixels, previous, canvas.width, canvas.height, rim, sec - lastSeen < .3 ? last :
        null);
      if (hit) {
        samples.push({
          ...hit,
          t: Math.round(sec * 1000)
        });
        last = hit;
        lastSeen = sec;
      }
      previous = pixels;
      progress((frame + 1) / (vid.duration * 12));
    }
    return basketCrossings(samples, rim, canvas.width, canvas.height).map(t => newEvent('basket', t, {
      status: 'proposed',
      origin: 'analysis',
      detector: SHOT_ENGINE,
      confidence: {
        event: 'medium',
        timing: 'medium',
        points: 'unknown',
        player: 'unknown',
        team: 'unknown'
      },
      evidence: 'A moving orange ball-sized region crossed the marked rim downwards and continued below it.'
    }));
  } finally {
    vid.removeAttribute('src');
    vid.load();
    vid.remove();
  }
}
export async function scanViolin(blob, settings, signal, progress) {
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('This browser could not decode the soundtrack. Open an audio-only WAV or M4A recording.');
  } finally {
    await ctx.close();
  }
  if (signal.aborted) throw cancelled();
  if (decoded.duration > 60.05) throw new Error('Automatic analysis supports clips up to 60 seconds.');
  const pcm = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < pcm.length; i++) pcm[i] += data[i] / decoded.numberOfChannels;
  }
  const rate = decoded.sampleRate;
  const notes = await new Promise((resolve, reject) => {
    const worker = new Worker('./pitch-worker.js', {
      type: 'module'
    });
    const finish = (callback, arg) => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      callback(arg);
    };
    const stop = () => finish(reject, cancelled());
    signal.addEventListener('abort', stop, {
      once: true
    });
    worker.onerror = () => finish(reject, new Error('The pitch worker could not start.'));
    worker.onmessage = ({
      data
    }) => {
      if (data.error) finish(reject, new Error(data.error));
      else if (data.notes) finish(resolve, data.notes);
      else progress(data.fraction);
    };
    worker.postMessage({
      pcm,
      rate,
      target: targetHz(settings)
    }, [pcm.buffer]);
  });
  return notes.map(n => newEvent('pitch', n.startMs, {
    endMs: n.endMs,
    status: 'proposed',
    origin: 'analysis',
    detector: PITCH_ENGINE,
    confidence: {
      event: n.confidence,
      pitch: n.confidence,
      timing: 'medium'
    },
    measurement: {
      hz: n.hz,
      targetHz: n.targetHz,
      cents: n.cents,
      spreadCents: n.spreadCents,
      target: settings.target
    },
    evidence: 'A stable, voiced interval had a repeating fundamental. Cents compare its median pitch with the selected target.'
  }));
}
