// Read an FFmpeg greyscale stream one frame at a time. No whole-match buffer.
import {FRAME_WIDTH, FRAME_HEIGHT, PIXELS, FOOTBALL_ENGINE, frameStep, compareFrames, findMoments} from '../public/football.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scanSound} from './match_audio.mjs';

export async function analyseFile(file, durationMs, ffmpeg) {
  const stepSeconds = frameStep(durationMs / 1000);
  const filter = 'fps=1/' + stepSeconds + ':start_time=0:round=up,scale=' + FRAME_WIDTH + ':' + FRAME_HEIGHT + ',format=gray';
  const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-i', file, '-an', '-sn', '-vf', filter,
    '-t', String(durationMs / 1000), '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    {stdio: ['ignore', 'pipe', 'inherit']});
  const exit = new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('close', resolve);
  });
  let tail = Buffer.alloc(0), previous = null, samples = 0;
  const frames = [];
  try {
    for await (const chunk of child.stdout) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let offset = 0;
      for (; offset + PIXELS <= data.length; offset += PIXELS) {
        if (samples > 3201) throw new Error('Unexpected number of decoded frames.');
        const frame = data.subarray(offset, offset + PIXELS);
        const timeMs = samples * stepSeconds * 1000;
        if (timeMs >= durationMs) continue;
        if (previous) frames.push(compareFrames(previous, frame, timeMs));
        previous = frame;
        samples++;
      }
      tail = data.subarray(offset);
    }
    if (await exit !== 0 || tail.length || !samples) throw new Error('The video track could not be decoded.');
    if (durationMs - samples * stepSeconds * 1000 > Math.max(2000, stepSeconds * 2000))
      throw new Error('The video track ended early. Try the original recording.');
    return {engine: FOOTBALL_ENGINE, durationMs, samples, stepSeconds, moments: findMoments(frames, stepSeconds)};
  } finally { if (child.exitCode === null) child.kill(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [file, ms, executable] = process.argv.slice(2);
    const program = executable || 'ffmpeg';
    const visual = await analyseFile(file, Number(ms), program);
    const audio = await scanSound(file, Number(ms), program);
    console.log(JSON.stringify({...visual, ...audio}));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
