import {validateScan} from './football.js';
import {analyserOrigin, studioOrigin} from './football-report.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const video = params.get('video'), request = params.get('request');
const origin = studioOrigin(params.get('studio'));
function status(text) { $('progress').textContent = text; }

async function api(path, options) {
  const response = await fetch(path, {cache: 'no-store', ...options});
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'The private analyser is unavailable.');
  return body;
}

async function analyse() {
  $('run').disabled = true;
  status('Starting the scan…');
  try {
    const {job} = await api('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-ChalaChitra': 'match'},
      body: JSON.stringify({video, request})});
    if (!/^[\w-]{32}$/.test(job)) throw new Error('Invalid job response.');
    for (;;) {
      const state = await api('/api/jobs/' + job);
      status(state.message);
      if (state.state === 'error') throw new Error(state.message);
      if (state.state === 'done') {
        const result = validateScan(state.result, video);
        const url = new URL('/', origin);
        url.hash = new URLSearchParams({matchResult: JSON.stringify({...result, request})}).toString();
        $('result').href = url.href;
        $('result').hidden = false;
        $('run').hidden = true;
        const sound = result.audioScanned ? ' and ' + result.whistles.length + ' whistle-like sounds' : '';
        status(result.moments.length + ' visual moments' + sound + ' from this match. Return to the timeline to review them.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
  } catch (err) {
    status(err.message || 'Connection interrupted. Reopen the scan to reconnect.');
    $('run').disabled = false;
  }
}

if (origin && /^[\w-]{11}$/.test(video || '') && /^[a-f0-9-]{36}$/.test(request || '') && analyserOrigin(location.origin)) {
  $('back').href = new URL('/', origin).href;
  $('back').hidden = false;
  $('run').hidden = false;
  $('run').onclick = analyse;
  $('matchTitle').textContent = 'YouTube · ' + video;
  status('Your private analyser will read this video from YouTube and temporarily decode a low-resolution track. The studio receives timestamps and measurements.');
} else {
  status('In the review studio, open a football match, enter this private Web Preview address and choose Analyse match.');
}
