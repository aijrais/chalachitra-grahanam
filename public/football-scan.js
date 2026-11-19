import {FRAME_WIDTH, FRAME_HEIGHT, FOOTBALL_ENGINE, frameStep, grayscale, compareFrames, findMoments} from './football.js';
import {mediaReady} from './analysis.js';

export async function scanFootballFile(url, source, signal, progress) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.className = 'analysis-video';
  video.setAttribute('aria-hidden', 'true');
  document.body.append(video);
  try {
    await mediaReady(video, 'loadeddata', signal, () => { video.src = url; video.load(); });
    if (!video.videoWidth) throw new Error('Choose a recording with a video track.');
    const durationMs = Math.round(video.duration * 1000);
    const step = frameStep(durationMs / 1000);
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    const frames = [];
    let previous, samples = 0;
    for (let timeMs = 0; timeMs < durationMs; timeMs += step * 1000) {
      signal.throwIfAborted();
      if (timeMs) await mediaReady(video, 'seeked', signal, () => { video.currentTime = timeMs / 1000; });
      ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      const pixels = grayscale(ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data);
      if (previous) frames.push(compareFrames(previous, pixels, timeMs));
      previous = pixels;
      samples++;
      progress(Math.min(1, (timeMs + step * 1000) / durationMs));
    }
    return {videoId: source.youtubeId, name: source.name, engine: FOOTBALL_ENGINE,
      durationMs, samples, stepSeconds: step, moments: findMoments(frames, step)};
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}
