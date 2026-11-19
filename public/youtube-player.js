let apiPromise;
function playerApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const failed = () => {
      clearTimeout(timeout);
      script.remove();
      apiPromise = undefined;
      reject(new Error('YouTube player controls could not connect.'));
    };
    const timeout = setTimeout(failed, 14000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      resolve(window.YT);
    };
    script.onerror = failed;
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  });
  return apiPromise;
}

// The iframe owns playback. Pixel analysis is supplied by an original file or the private analyser.
export function openYouTube(host, id, onInfo, onError) {
  const frame = document.createElement('iframe');
  frame.title = 'YouTube match player';
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  const url = new URL('https://www.youtube-nocookie.com/embed/' + id);
  url.search = new URLSearchParams({enablejsapi: '1', playsinline: '1', origin: location.origin}).toString();
  frame.src = url.href;
  host.replaceChildren(frame);
  let player, ready = false, apiFailed = false, disposed = false, pendingSeek = null;
  const cancel = new AbortController();
  function info() {
    if (!disposed && ready) onInfo({duration: player.getDuration()});
  }
  playerApi().then(api => {
    if (disposed) return;
    player = new api.Player(frame, {host: 'https://www.youtube-nocookie.com', events: {
      onReady() {
        if (disposed) return;
        ready = true;
        if (pendingSeek !== null) player.seekTo(pendingSeek, true);
        info();
      },
      onStateChange: info,
      onError() { if (!disposed) onError('YouTube could not play this video here. Open it on YouTube or attach your own recording.'); }
    }});
  }).catch(err => {
    if (disposed) return;
    apiFailed = true;
    if (pendingSeek !== null) nativeSeek(false);
    onError(err.message + ' Use the player and enter event times manually.');
  });
  function nativeSeek(play) {
    const fallback = new URL(url);
    fallback.searchParams.delete('enablejsapi');
    fallback.searchParams.set('start', String(Math.floor(pendingSeek || 0)));
    if (play) fallback.searchParams.set('autoplay', '1');
    frame.src = fallback.href;
  }
  const metadata = new URL('https://www.youtube.com/oembed');
  metadata.search = new URLSearchParams({url: 'https://www.youtube.com/watch?v=' + id, format: 'json'}).toString();
  fetch(metadata, {credentials: 'omit', signal: cancel.signal}).then(r => r.ok ? r.json() : null).then(data => {
    if (!disposed && typeof data?.title === 'string') onInfo({title: data.title.trim().slice(0, 255)});
  }).catch(() => {});
  return {
    time() { return ready ? player.getCurrentTime() : null; },
    pause() { if (ready) player.pauseVideo(); },
    seek(s) { pendingSeek = s; if (ready) player.seekTo(s, true); else if (apiFailed) nativeSeek(false); },
    play() { if (ready) player.playVideo(); else if (apiFailed) nativeSeek(true); },
    destroy() { disposed = true; cancel.abort(); player?.destroy(); host.replaceChildren(); }
  };
}
