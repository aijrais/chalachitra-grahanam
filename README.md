# ChalaChitra Grahanam

ChalaChitra is a mobile-friendly review studio for football matches, basketball clips and Carnatic practice. It keeps review drafts on the device and exports timestamped JSON and WebVTT. A private companion can analyse a YouTube match from its link. The Firebase site serves static assets.

## Try the football branch on Firebase

Use the existing clone in your Google Cloud Shell. The trial publishes to the separate `football` preview channel. The publisher checks that billing is disabled and unlinked. Keep the shell running while scanning links. No Google token, YouTube API key or persistent service account is needed by the studio.

```sh
cd ~/chalachitra-grahanam
git fetch origin
git switch trials_football_analysis
git pull --ff-only origin trials_football_analysis
bash scripts/start-football.sh --preview
```

In the Cloud Shell that is running the analyser, choose **Web Preview → Preview on port 8080**. Use the browser profile signed in to that shell’s Google account. When **Match analyser** opens, choose **Open football studio**. Paste the YouTube link into the studio and choose **Save address → Analyse match → Start match scan → Review moments in studio**. The studio keeps the account number from the working Web Preview address when Google supplies one.

For a Firebase-only preview, run `python3 scripts/hosting.py preview --channel football`. Open a match and choose **Use original video → Analyse match** to scan its original file on your device. The original can exceed the studio's usual 64 MiB limit. To connect an existing deployment, run `bash scripts/start-football.sh`, use Cloud Shell's Web Preview and copy that page's address into **Connect a private link analyser**. Ctrl-C stops the companion. On first use, the launcher installs its Python dependencies under the ignored `.firebase/football-env/`. It also runs on a computer with Python 3.10+, a supported Node.js 22+ release and a loopback browser.

### If Analyse opens a 404

Keep the failed browser tab open. In the Google Cloud console that owns the running shell, choose **Web Preview → Preview on port 8080**. If you see **Match analyser**, reload the failed tab. To check the listener from a second terminal in the same Cloud Shell, run `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/match.html`. A local 200 confirms the analyser page is available inside the shell. A connection error means you should check that the launcher is running on that port.

You can also finish the pending scan in the terminal, including with an older Firebase football preview. Run these commands in a second Cloud Shell terminal.

```sh
cd ~/chalachitra-grahanam
git switch trials_football_analysis
git pull --ff-only
bash scripts/start-football.sh --resume
```

At the prompt, paste the entire address from the failed tab, including the part after `#`. The command runs the same analyser directly. When it prints the review link, **paste the whole link into the address bar of that same failed tab**. The studio matches the pending request in that tab and merges the suggestions with your existing timeline. No redeployment is needed for this recovery. If YouTube declines to serve the recording to Cloud Shell, select **Use original video** in the studio.

### What football analysis extracts

The analyser samples the whole recording at a duration-dependent interval and identifies bursts of movement and abrupt view changes. Each proposed moment includes a video timestamp, the percentage of sampled image cells that changed, and the reason to review it. Camera pans, cuts and spectators can also produce these signals. When the link supplies audio, the companion also flags sustained whistle-like tones and records their frequency and start and end times. A tone can come from a spectator, a referee or an electronic sound. A quiet recording can return an empty timeline. The summary counts only the goals, shots, saves, corners, fouls and passes you confirm. A single tag can carry a team and player. Use **Add event** to tag play the detector missed. The timeline, corrections and export format work the same for other videos.

- **From a link.** YouTube supplies the embedded player. To scan footage, the companion requests a low-resolution video track from YouTube for recordings you own or may process. It uses temporary disk space, returns measurements to your Firebase tab and removes the media after the job. The return data travels in a URL fragment and goes into the device’s draft. An active private Cloud Shell is required during a link scan.
- **From an original.** Restricted uploads and some YouTube servers may decline a link request. The same visual detector runs in your browser on a matching video file. Replay timestamps use the video clock. Reattaching checks the duration and a small signature of the file’s beginning, middle and end.
- **Limits.** Football scans accept recordings of up to three hours. The link analyser accepts a track of up to 450 MiB. The detector compares up to roughly 3,200 frames and returns up to 60 spaced visual suggestions across the match. The private audio scan can return up to 40 whistle-like intervals. Fast actions between samples can be missed. Team names, player identities and the final score require review.
- **Extension points.** `public/football.js` contains the event vocabulary and the pure frame detector. The file scanner and the private decoder both feed it greyscale frames. `public/football-report.js` turns their results into ordinary timeline events and merges repeat scans while preserving reviewed decisions. The detector uses measured changes in the picture across the recording and can work with different kits, pitches and camera angles.

Development uses `trials_<feature_name>` branches. The owner reviews code before it goes to `main`.

## Run locally

Use Python 3 from the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory public
```

Open <http://localhost:8000>. On a phone, use the HTTPS Hosting preview below. Open the studio online once to cache its interface and samples. Local recordings must be reselected after reopening the app.

## Preview from Google Cloud Shell

The publisher uses the current Google Cloud Shell login and the Firebase Hosting REST API. It is configured for the existing project and site `chalachitram-42da6`. It verifies that billing is disabled and unlinked before a release. Credentials stay in the shell process.

```sh
git clone https://github.com/aijrais/chalachitra-grahanam.git
cd chalachitra-grahanam
python3 scripts/hosting.py preview
```

The last line of output gives the Firebase preview URL. The default preview uses `pilot`. Select a separate channel with `--channel football`. New preview channels have a seven-day expiry. A preview URL can be opened by anyone who has the link. The published assets are the contents of `public/`, including the synthetic samples. Keep personal recordings outside that directory.

Run `python3 scripts/hosting.py check` for a read-only project and site check. Rerun the same preview command after an interrupted upload. It saves the build ID and Firebase version under the ignored `.firebase/` directory and reuses a matching release. After reviewing the preview, `python3 scripts/hosting.py live` publishes the checkout to <https://chalachitram-42da6.web.app>. This explicit live action can replace the site's current release. To get a later revision, use `git pull --ff-only` from the clone first.

## Try a recording

- **Basketball.** Open the 10-second Court practice sample or a fixed-camera clip with an orange ball and one visible hoop. For your own clip, tap the left and right rim edges, then choose **Analyse clip**. A downward crossing becomes a suggestion for review. Enter 1, 2 or 3 points, team and player when the footage supports them. The summary counts confirmed makes, adds known point values and shows how many confirmed baskets still lack a value. Team and player rows use reviewer assignments.
- **Carnatic violin.** Open the Held Sa example or a solo recording. Choose a tonic and a held target of Sa, Pa, upper Sa or a reference frequency in Hz. Analyse pitch to see sustained intervals, measured frequencies and signed cents from the chosen target. Positive cents are sharp. Pa uses a 3:2 ratio and upper Sa uses 2:1. The exercise is designed for stable tones. Ornamented passages, physical fingering and visual posture are outside this version.
- **Manual annotations.** Play or scrub, choose **Add event**, then enter the event time or an interval. Events appear over the recording during playback. Select a timeline row to seek, inspect the evidence, correct its details or change its review status. **Replay** starts just before the event. The exported report preserves the original time and measurements for corrected automatic suggestions.
- **YouTube matches.** Choose **Open football match** and paste a video link. Select a timeline row to seek, replay a passage, and confirm or correct an event. Use **Open on YouTube** if embedding is restricted.
- **Durability.** Drafts are saved in this browser's IndexedDB. Under **Export**, choose JSON and keep it alongside the original media, with a second copy elsewhere. In another browser, import the JSON and attach the same file. The SHA-256 fingerprint permits renamed originals and detects different files. Export WebVTT for caption players. VTT includes confirmed and proposed events, labels proposals and omits dismissed events. JSON retains all statuses.
- **Basketball and violin limits.** Standalone local files can be up to 64 MiB. Automatic basketball and pitch analysis accepts clips up to 60 seconds. Longer playable recordings support manual annotation. Use an audio-only WAV or M4A if the browser can play a video but cannot decode its soundtrack for analysis. No footage is stored in the offline cache or draft database.

## Confidence and sample evidence

The basketball detector tracks frame-to-frame motion of orange, ball-sized components near a calibrated rim. It checks downward travel above, through and below the rim. Moving cameras, occlusion, ball colour and foreground clutter affect results. A geometric crossing is a proposal. The current detector leaves points, team and player unknown.

The pitch detector runs a normalized difference pitch estimate in a background worker. It groups steady voiced windows, reports their median frequency and estimates confidence from periodicity and pitch spread. Confidence labels describe the available evidence. They have not been calibrated as probabilities.

The court sample uses an original AI-generated gym background with three simulated throws. The sample's preloaded timeline is an authored review example. The middle throw goes wide. The audio sample is synthesised with two held tones, one at 220 Hz and one 22 cents below it. These controlled examples exercise the software. Accuracy on real games and performances still needs labelled recordings from separate sessions.

## Tests

Use Node.js 22 or later and Python 3. FFmpeg enables the encoded-video regressions, including a 48-minute football fixture with motion near the beginning, middle and end. Automated tests substitute a local media source for YouTube.

```sh
npm test
```

The offline cache gets a new version for every changed REST deployment. The tests cover signal detection on the bundled media, report validation and restoration, VTT timing, the Firebase cost check and resuming an interrupted publication against a simulated Hosting API. The runtime code is in `public/`, the Cloud Shell publisher in `scripts/hosting.py`, and Firebase response headers in `firebase.json`. The bundled Barlow fonts are distributed under the licence in `public/assets/Barlow-OFL.txt`.
