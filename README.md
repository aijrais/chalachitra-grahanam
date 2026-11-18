# ChalaChitra Grahanam

A static, installable review studio for basketball clips and Carnatic practice recordings. Open a file, review suggestions on the timeline, correct the evidence and take the report with you. Media decoding and analysis run in the browser. The app has no cloud database, upload endpoint, accounts or runtime package dependencies.

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

The last line of output gives the Firebase preview URL. The first run creates a channel named `pilot` with a seven-day expiry. A preview URL can be opened by anyone who has the link. The published assets are the contents of `public/`, including the synthetic samples. Keep personal recordings outside that directory.

Run `python3 scripts/hosting.py check` for a read-only project and site check. Rerun the same preview command after an interrupted upload. It saves the build ID and Firebase version under the ignored `.firebase/` directory and reuses a matching release. After reviewing the preview, `python3 scripts/hosting.py live` publishes the checkout to <https://chalachitram-42da6.web.app>. This explicit live action can replace the site's current release. To get a later revision, use `git pull --ff-only` from the clone first.

## Try a recording

- **Basketball.** Open the 10-second Court practice sample or a fixed-camera clip with an orange ball and one visible hoop. For your own clip, tap the left and right rim edges, then choose **Analyse clip**. A downward crossing becomes a suggestion for review. Enter 1, 2 or 3 points, team and player when the footage supports them. The summary counts confirmed makes, adds known point values and shows how many confirmed baskets still lack a value. Team and player rows use reviewer assignments.
- **Carnatic violin.** Open the Held Sa example or a solo recording. Choose a tonic and a held target of Sa, Pa, upper Sa or a reference frequency in Hz. Analyse pitch to see sustained intervals, measured frequencies and signed cents from the chosen target. Positive cents are sharp. Pa uses a 3:2 ratio and upper Sa uses 2:1. The exercise is designed for stable tones. Ornamented passages, physical fingering and visual posture are outside this version.
- **Manual annotations.** Play or scrub, choose **Add event**, then enter the event time or an interval. Events appear over the recording during playback. Select a timeline row to seek, inspect the evidence, correct its details or change its review status. **Replay** starts just before the event. The exported report preserves the original time and measurements for corrected automatic suggestions.
- **YouTube references.** Use **Open recording → Add a YouTube reference** to bookmark a link by timestamp. Opening a bookmark on YouTube is an explicit external action. Attach the creator's original recording for local analysis.
- **Durability.** Drafts are saved in this browser's IndexedDB. Under **Export**, choose JSON and keep it alongside the original media, with a second copy elsewhere. In another browser, import the JSON and attach the same file. The SHA-256 fingerprint permits renamed originals and detects different files. Export WebVTT for caption players. VTT includes confirmed and proposed events, labels proposals and omits dismissed events. JSON retains all statuses.
- **Limits.** Local files can be up to 64 MiB. Automatic analysis accepts clips up to 60 seconds. Longer playable recordings support manual annotation. Use an audio-only WAV or M4A if the browser can play a video but cannot decode its soundtrack for analysis. No footage is stored in the offline cache or draft database.

## Confidence and sample evidence

The basketball detector tracks frame-to-frame motion of orange, ball-sized components near a calibrated rim. It checks downward travel above, through and below the rim. Moving cameras, occlusion, ball colour and foreground clutter affect results. A geometric crossing is a proposal. The current detector leaves points, team and player unknown.

The pitch detector runs a normalized difference pitch estimate in a background worker. It groups steady voiced windows, reports their median frequency and estimates confidence from periodicity and pitch spread. Confidence labels describe the available evidence. They have not been calibrated as probabilities.

The court sample uses an original AI-generated gym background with three simulated throws. The sample's preloaded timeline is an authored review example. The middle throw goes wide. The audio sample is synthesised with two held tones, one at 220 Hz and one 22 cents below it. These controlled examples exercise the software. Accuracy on real games and performances still needs labelled recordings from separate sessions.

## Tests

Use Node.js 22 or later and Python 3. FFmpeg enables the video decoding regression.

```sh
npm test
```

The offline cache gets a new version for every changed REST deployment. The tests cover signal detection on the bundled media, report validation and restoration, VTT timing, the Firebase cost check and resuming an interrupted publication against a simulated Hosting API. The runtime code is in `public/`, the Cloud Shell publisher in `scripts/hosting.py`, and Firebase response headers in `firebase.json`. The bundled Barlow fonts are distributed under the licence in `public/assets/Barlow-OFL.txt`.
