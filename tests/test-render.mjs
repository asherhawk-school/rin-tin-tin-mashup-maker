// Renders mashups of synthetic songs and checks the freestyle's beats land on the
// song's in the rendered audio, before and after the loop point, for a freestyle
// at the song's sample rate and at a different one.
// run: node tests/test-render.mjs

import { analyzeTrack, bpm } from '../src/analysis.js';
import { renderMashup } from '../src/mashup.js';
import { renderSong, levelSong, freestyleSong } from './synth.js';
import { check, summary } from './util.js';

function run(label, rttRate, settings) {
    console.log(label);
    const songAudio = { sampleRate: levelSong.sampleRate, channels: [renderSong(levelSong)] };
    const rttAudio = { sampleRate: rttRate, channels: [renderSong({ ...freestyleSong, sampleRate: rttRate })] };
    const songInfo = analyzeTrack(songAudio.channels[0], songAudio.sampleRate);
    const rttInfo = analyzeTrack(rttAudio.channels[0], rttAudio.sampleRate);

    const start = performance.now();
    const result = renderMashup({ song: songAudio, rtt: rttAudio, songInfo, rttInfo, settings: { bassCut: 0, ...settings } });
    const seconds = (performance.now() - start) / 1000;
    const { plan } = result;
    const loopAt = plan.songAnchor + (plan.loopStart + plan.loopLength - plan.rttAnchor) / plan.speed;
    console.log(`  speed x${plan.speed.toFixed(4)}, pitch x${plan.pitch.toFixed(4)}, ${plan.semitones >= 0 ? '+' : ''}${plan.semitones} st, loops back at ${loopAt.toFixed(1)} s; rendered in ${seconds.toFixed(1)} s`);

    const rate = result.sampleRate;
    const songPeriod = 60 / levelSong.bpm;
    let finite = true, peak = 0;
    for (const ch of result.channels) for (const v of ch) {
        if (!Number.isFinite(v)) finite = false;
        peak = Math.max(peak, Math.abs(v));
    }
    check(finite && peak <= 0.981, `output is clean (peak ${peak.toFixed(3)})`);
    check(result.channels[0].length === songAudio.channels[0].length, 'output is as long as the song');

    for (const [from, to] of [[3, 20], [40, 60], [loopAt + 2, loopAt + 20]]) {
        const a = Math.round(from * rate), b = Math.round(to * rate);
        const fs = analyzeTrack(result.stems.freestyle[0].slice(a, b), rate);
        const sg = analyzeTrack(result.stems.song[0].slice(a, b), rate);
        const offset = (fs.beatPhase - sg.beatPhase) - songPeriod * Math.round((fs.beatPhase - sg.beatPhase) / songPeriod);
        console.log(`  ${from.toFixed(0).padStart(3)}-${to.toFixed(0).padEnd(3)} s: freestyle ${bpm(fs).toFixed(2)} BPM vs song ${bpm(sg).toFixed(2)} BPM, offset ${(offset * 1000).toFixed(1)} ms`);
        const ratio = fs.beatPeriod / songPeriod;
        check([0.5, 1, 2].some((r) => Math.abs(ratio / r - 1) < 0.003), 'tempo matches');
        check(Math.abs(offset) < 0.012, 'beats line up within 12 ms');
    }
}

run('freestyle at 44.1 kHz, key matched', 44100, {});
run('freestyle at 48 kHz, record-style (pitch follows speed)', 48000, { keepPitch: false });
summary();
