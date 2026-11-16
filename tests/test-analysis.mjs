// Tempo, beat phase, bar and key detection on synthetic songs with known answers.
// run: node tests/test-analysis.mjs

import { analyzeTrack, bpm, firstDownbeat, keyName } from '../src/analysis.js';
import { renderSong, levelSong, freestyleSong, fastSong } from './synth.js';
import { check, gridError, summary } from './util.js';

const relMajor = (root, minor) => (minor ? (root + 3) % 12 : root);

function runCase(name, song, keyRoot, keyMinor, allowHalfTime = false) {
    console.log(name);
    const audio = renderSong(song);
    const start = performance.now();
    const info = analyzeTrack(audio, song.sampleRate);
    const ms = performance.now() - start;
    const truePeriod = 60 / song.bpm;
    const trueDownbeat = song.firstBeat + song.firstDownbeat * truePeriod;
    console.log(`  detected ${bpm(info).toFixed(3)} BPM (true ${song.bpm}), key ${keyName(info.keyRoot, info.keyMinor)} (${info.keyStrength.toFixed(2)}), took ${ms.toFixed(0)} ms`);

    const ratio = info.beatPeriod / truePeriod;
    const octave = Math.pow(2, Math.round(Math.log2(ratio)));
    check(Math.abs(ratio / octave - 1) < 0.0005, 'tempo within 0.05%');
    check(octave === 1 || (allowHalfTime && octave === 2), 'tempo octave');
    const phaseErr = gridError(info.beatPhase, song.firstBeat, truePeriod);
    console.log(`  beat phase error ${(phaseErr * 1000).toFixed(1)} ms, downbeat error ${(gridError(firstDownbeat(info), trueDownbeat, 4 * truePeriod) * 1000).toFixed(1)} ms`);
    check(phaseErr < 0.012, 'beat phase within 12 ms');
    check(gridError(firstDownbeat(info), trueDownbeat, 4 * truePeriod) < 0.012, 'downbeat on the bar line');
    check(relMajor(info.keyRoot, info.keyMinor) === relMajor(keyRoot, keyMinor), 'key (or its relative)');
}

runCase('128 BPM, A minor, pickup beats', levelSong, 9, true);
runCase('93.5 BPM, D major', freestyleSong, 2, false);
runCase('174 BPM, E minor', fastSong, 4, true, true);
summary();
