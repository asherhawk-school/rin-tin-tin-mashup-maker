// Tiny drum-and-chords synth for generating test songs with known beats, bars and key.

export function renderSong({
    bpm = 120,
    firstBeat = 0,          // seconds
    firstDownbeat = 0,      // beat index (from firstBeat) where bar 1 starts
    fourOnFloor = true,     // kick every beat, else on 1 and 3
    chords = [],            // MIDI notes, one chord per bar, cycled
    duration = 60,
    sampleRate = 44100,
}) {
    const n = Math.floor(duration * sampleRate);
    const out = new Float32Array(n);
    const period = 60 / bpm;
    let rng = 12345;
    const noise = () => {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        return (rng | 0) / 2147483648;
    };
    const add = (t, v) => {
        const i = Math.round(t * sampleRate);
        if (i >= 0 && i < n) out[i] += v;
    };
    const midiHz = (note) => 440 * Math.pow(2, (note - 69) / 12);

    for (let beat = 0; ; beat++) {
        const t0 = firstBeat + beat * period;
        if (t0 >= duration) break;
        const barPos = (((beat - firstDownbeat) % 4) + 4) % 4;
        if (fourOnFloor || barPos === 0 || barPos === 2) {
            let phase = 0;
            for (let t = 0; t < 0.25; t += 1 / sampleRate) {
                const f = 50 + 110 * Math.exp(-t / 0.03);
                phase += 2 * Math.PI * f / sampleRate;
                add(t0 + t, 0.8 * Math.exp(-t / 0.12) * Math.sin(phase));
            }
        }
        if (barPos === 1 || barPos === 3) {
            for (let t = 0; t < 0.2; t += 1 / sampleRate) {
                add(t0 + t, Math.exp(-t / 0.06) * (0.35 * noise() + 0.25 * Math.sin(2 * Math.PI * 190 * t)));
            }
        }
        let last = 0;
        for (let t = 0; t < 0.06; t += 1 / sampleRate) {
            const w = noise();
            add(t0 + period / 2 + t, 0.12 * Math.exp(-t / 0.015) * (w - last));
            last = w;
        }
    }

    if (chords.length) {
        const bar = 4 * period;
        const barStart = firstBeat + firstDownbeat * period;
        for (let i = 0; i < n; i++) {
            const t = i / sampleRate;
            const rel = (t - barStart) / bar;
            const barIndex = Math.floor(rel);
            const inBar = (rel - barIndex) * bar;
            const chord = chords[((barIndex % chords.length) + chords.length) % chords.length];
            const env = Math.min(1, inBar / 0.02) * Math.exp(-inBar / 3);
            let v = 0;
            for (const note of chord) {
                const f = midiHz(note);
                for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * 1.5);
            }
            v += 1.2 * Math.sin(2 * Math.PI * midiHz(chord[0] - 12) * t);
            out[i] += 0.06 * env * v;
        }
    }
    return out;
}

// the songs the C++ tests use
export const levelSong = { bpm: 128, firstBeat: 0.37, firstDownbeat: 2, fourOnFloor: true, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], duration: 150, sampleRate: 44100 };
export const freestyleSong = { bpm: 93.5, firstBeat: 1.1, firstDownbeat: 1, fourOnFloor: false, chords: [[50, 54, 57], [55, 59, 62], [57, 61, 64], [59, 62, 66]], duration: 120, sampleRate: 44100 };
export const fastSong = { bpm: 174, firstBeat: 0.05, firstDownbeat: 0, fourOnFloor: true, chords: [[52, 55, 59], [48, 52, 55], [55, 59, 62], [50, 54, 57]], duration: 90, sampleRate: 44100 };
