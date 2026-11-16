# Rin Tin Tin Mashup Maker

Mash any song up with the Rin Tin Tin freestyle, right in your browser: the freestyle is beat-matched, lined up bar for bar and shifted into a key that fits the song.

**Use it:** https://asherhawk-school.github.io/rin-tin-tin-mashup-maker/

1. Drop in your copy of the Rin Tin Tin freestyle (a vocals-only version mixes cleanest). It's remembered on your device for next time.
2. Drop in any song.
3. Hit **Make mashup**, listen, and download the WAV.

Nothing is uploaded: decoding, analysis and rendering all happen locally. This repo doesn't contain or host any music; bring your own files.

## Fine-tuning

| Setting | What it does |
| --- | --- |
| Freestyle / song volume | Balance between the two. The mix is normalised so it never clips. |
| Freestyle bass cut | High-passes the freestyle so its kick and bass don't fight the song's. |
| Skip freestyle intro | Starts later in the freestyle (still on a bar line). |
| Beat shift | Slides the freestyle by whole beats if the bars feel off (4 = one bar). |
| Fine offset | Nudges it by milliseconds. |
| Match key | Transposes the freestyle into a key that fits the song. |
| Keep pitch | Off gives a sped-up / slowed record sound instead of a time-stretch. |
| Loop freestyle | Repeats it on a phrase boundary when the song is longer. |

## How it works

- **Tempo** (`src/analysis.js`): an onset envelope is built from third-octave-band spectral flux (so hi-hats don't outweigh kicks), the beat period is picked where a Fourier tempogram and autocorrelation agree (avoiding double/half-tempo mistakes), then a comb fit across the whole song pins it to about 0.01 BPM and the beat phase to a few milliseconds.
- **Bars**: of the four beat positions, the one where harmony changes, energy jumps and kicks land hardest is taken as beat one.
- **Key**: chroma with overtone suppression, matched against Krumhansl–Kessler profiles. The freestyle goes to the same key or a fifth away, whichever needs the least pitch-shifting.
- **Rendering** (`src/mashup.js`): the freestyle is time-stretched with WSOLA (keeps drums and vocals crisp), resampled for the key change, laid onto the song's timeline from the first bar line, looped on 4-bar phrases with short crossfades, and mixed.

All of it runs in a Web Worker (`src/worker.js`); the page is plain HTML, CSS and ES modules with no build step or dependencies.

## Development

Serve the folder with any static server, e.g. `python3 -m http.server`, and open it.

Tests (Node 20+) use synthetic songs with known tempo, bars and key:

```bash
node tests/test-analysis.mjs
node tests/test-render.mjs
```

`test-render` renders full mashups and checks that the freestyle's beats land on the song's in the output, before and after the loop point.
