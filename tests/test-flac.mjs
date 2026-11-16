// Encodes awkward test signals to FLAC and checks a real decoder gives back the
// exact samples. Uses macOS's afconvert (CoreAudio) when it's available.
// run: node tests/test-flac.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFlac } from '../src/flac.js';
import { renderSong, levelSong } from './synth.js';
import { check, summary } from './util.js';

function readWav16(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 12, channels = 0;
    while (offset + 8 <= view.byteLength) {
        const id = String.fromCharCode(...buffer.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        if (id === 'fmt ') channels = view.getUint16(offset + 10, true);
        if (id === 'data') {
            const samples = new Int16Array(size / 2);
            for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true);
            return { channels, samples };
        }
        offset += 8 + size + (size & 1);
    }
    throw new Error('no data chunk');
}

let rng = 7;
const noise = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return (rng | 0) / 2147483648;
};

const music = renderSong({ ...levelSong, duration: 20 });
const cases = [
    ['stereo music, different channels', 44100, [music, music.map((v, i) => 0.7 * v + 0.2 * Math.sin(i / 40))]],
    ['mono music, odd length', 44100, [music.subarray(0, 44100 * 7 + 1234)]],
    ['silence then a constant', 48000, [new Float32Array(30000).map((_, i) => (i < 20000 ? 0 : 0.25)), new Float32Array(30000)]],
    ['white noise (barely compressible)', 44100, [new Float32Array(100000).map(noise), new Float32Array(100000).map(noise)]],
    ['full-scale square wave', 22050, [new Float32Array(50000).map((_, i) => ((i >> 5) & 1 ? 1 : -1)), new Float32Array(50000).map((_, i) => ((i >> 7) & 1 ? -1 : 1))]],
    ['shorter than one block', 44100, [new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.5)]],
];

let afconvert = true;
try {
    execFileSync('which', ['afconvert'], { stdio: 'ignore' });
}
catch {
    afconvert = false;
}

const dir = mkdtempSync(join(tmpdir(), 'flac-test-'));
for (const [name, rate, channels] of cases) {
    console.log(name);
    const start = performance.now();
    const flac = encodeFlac(channels, rate);
    const ms = performance.now() - start;
    const ratio = flac.length / (channels.length * channels[0].length * 2);
    console.log(`  ${flac.length} bytes, ${(ratio * 100).toFixed(0)}% of WAV size, ${ms.toFixed(0)} ms`);

    const expected = channels.map((ch) => Int16Array.from(ch, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767)));
    if (!afconvert) {
        console.log('  (afconvert not available, skipping decode check)');
        continue;
    }
    const inPath = join(dir, 'in.flac'), outPath = join(dir, 'out.wav');
    writeFileSync(inPath, flac);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', inPath, outPath]);
    const decoded = readWav16(readFileSync(outPath));
    let mismatches = 0;
    const frames = decoded.samples.length / decoded.channels;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels.length; c++) {
            if (decoded.samples[i * decoded.channels + c] !== expected[c][i]) mismatches++;
        }
    }
    check(decoded.channels === channels.length && frames === expected[0].length, `CoreAudio decodes ${frames} frames x ${decoded.channels} channels`);
    check(mismatches === 0, `bit-exact (${mismatches} mismatched samples)`);
}
rmSync(dir, { recursive: true, force: true });
summary();
