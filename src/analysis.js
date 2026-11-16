// Tempo, beat grid, bar lines and key detection, plus working out how to line
// two tracks up. Pure functions on Float32Arrays so it runs in a worker or Node.

// onset envelope: ~11ms hops at ~22kHz
const ONSET_N = 1024;
const ONSET_HOP = 256;
// where in the analysis window (as a fraction of its length) a detected onset really is
const ONSET_TIME_OFFSET = 0.59;
const ONSET_COMPRESSION = 1e4;
// chroma: ~5Hz bins so low notes resolve to the right pitch class
const CHROMA_N = 4096;
const CHROMA_HOP = 2048;
// below this the key guess is treated as noise
const MIN_KEY_STRENGTH = 0.4;
// share of a note's level expected at its 3rd and 5th harmonics
const FIFTH_OVERTONE = 0.2;
const THIRD_OVERTONE = 0.1;

// in-place radix-2 FFT on split real/imaginary arrays
class FFT {
    constructor(n) {
        this.n = n;
        this.rev = new Uint32Array(n);
        let bits = 0;
        while ((1 << bits) < n) bits++;
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
            this.rev[i] = r;
        }
        this.cos = new Float64Array(n / 2);
        this.sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            this.cos[i] = Math.cos(2 * Math.PI * i / n);
            this.sin[i] = -Math.sin(2 * Math.PI * i / n);
        }
    }

    forward(re, im) {
        const n = this.n, rev = this.rev;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1, step = n / len;
            for (let i = 0; i < n; i += len) {
                for (let j = 0; j < half; j++) {
                    const wr = this.cos[j * step], wi = this.sin[j * step];
                    const a = i + j, b = a + half;
                    const vr = re[b] * wr - im[b] * wi;
                    const vi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - vr;
                    im[b] = im[a] - vi;
                    re[a] += vr;
                    im[a] += vi;
                }
            }
        }
    }
}

// calls fn(frameIndex, magnitudes) for every Hann-windowed frame; magnitudes are
// scaled so a full-scale sine peaks near 1
function forEachFrame(x, n, hop, fn) {
    if (x.length < n) return;
    const frames = Math.floor((x.length - n) / hop) + 1;
    const fft = new FFT(n);
    const window = new Float64Array(n);
    for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n), mag = new Float64Array(n / 2 + 1);
    const norm = 4 / n;
    for (let f = 0; f < frames; f++) {
        const start = f * hop;
        for (let i = 0; i < n; i++) {
            re[i] = x[start + i] * window[i];
            im[i] = 0;
        }
        fft.forward(re, im);
        for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
        fn(f, mag);
    }
}

// low-pass (zero phase, so no timing shift) and drop to ~22kHz
function downsample(input, rate) {
    const factor = Math.max(1, Math.floor(rate / 20000));
    if (factor === 1) return { x: input, rate };

    const taps = 63, half = (taps - 1) / 2;
    const cutoff = 0.45 / factor;
    const h = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const m = i - half;
        const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
        h[i] = sinc * blackman;
        sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;

    const out = new Float32Array(Math.floor(input.length / factor));
    const size = input.length;
    for (let o = 0; o < out.length; o++) {
        const centre = o * factor;
        let acc = 0;
        if (centre - half >= 0 && centre + half < size) {
            const base = centre - half;
            for (let i = 0; i < taps; i++) acc += h[i] * input[base + i];
        }
        else {
            for (let i = 0; i < taps; i++) {
                const idx = centre + i - half;
                if (idx >= 0 && idx < size) acc += h[i] * input[idx];
            }
        }
        out[o] = acc;
    }
    return { x: out, rate: rate / factor };
}

// subtract a centred moving average and keep the positive part
function removeLocalMean(x, half) {
    const prefix = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
        const lo = Math.max(0, i - half), hi = Math.min(x.length, i + half + 1);
        const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
        out[i] = Math.max(0, x[i] - mean);
    }
    return out;
}

function computeOnsets(x, rate) {
    const fps = rate / ONSET_HOP;
    const timeOffset = ONSET_TIME_OFFSET * ONSET_N / rate;

    // Flux is summed over third-octave bands rather than raw bins, otherwise
    // broadband hi-hats (hundreds of bins) drown out kicks and snares (a handful)
    // and the beat lands on the off-beats.
    const bins = ONSET_N / 2 + 1;
    const binHz = rate / ONSET_N;
    const bandOfBin = new Int32Array(bins).fill(-1);
    const bandWeight = [], bandIsLow = [], bandBins = [];
    const third = Math.pow(2, 1 / 3);
    let lo = 30;
    const top = Math.min(11000, rate * 0.475);
    while (lo < top) {
        let hi = lo * third;
        // widen until the band holds at least one bin
        while (hi < top && Math.ceil(hi / binHz) <= Math.ceil(lo / binHz)) hi *= third;
        const band = bandBins.length;
        let count = 0;
        for (let k = Math.ceil(lo / binHz); k < bins && k * binHz < hi; k++) {
            if (bandOfBin[k] < 0) {
                bandOfBin[k] = band;
                count++;
            }
        }
        if (count) {
            bandBins.push(count);
            const low = hi <= 220;
            bandIsLow.push(low);
            // kick and bass carry the beat
            bandWeight.push(low ? 1.5 : 1.0);
        }
        lo = hi;
    }
    const bands = bandBins.length;

    let prev = new Float64Array(bands), cur = new Float64Array(bands);
    const flux = [], low = [], energy = [];
    forEachFrame(x, ONSET_N, ONSET_HOP, (f, mag) => {
        cur.fill(0);
        let e = 0;
        for (let k = 1; k < bins; k++) {
            const v = mag[k] * mag[k];
            e += v;
            const b = bandOfBin[k];
            if (b >= 0) cur[b] += v;
        }
        let sum = 0, lowSum = 0;
        for (let b = 0; b < bands; b++) {
            cur[b] = Math.log1p(ONSET_COMPRESSION * cur[b] / bandBins[b]);
            const diff = cur[b] - prev[b];
            if (diff > 0) {
                sum += bandWeight[b] * diff;
                if (bandIsLow[b]) lowSum += diff;
            }
        }
        flux.push(f ? sum : 0);
        low.push(f ? lowSum : 0);
        energy.push(e);
        const t = prev; prev = cur; cur = t;
    });

    const half = Math.floor(fps * 0.2);
    return {
        onset: removeLocalMean(flux, half),
        low: removeLocalMean(low, half),
        energy: Float64Array.from(energy),
        fps,
        timeOffset,
    };
}

// |sum of o[t] * e^(-2*pi*i*t/period)| over [from, to), relative to the onset total
function pulseClarity(o, from, to, period) {
    const w = 2 * Math.PI / period;
    const cs = Math.cos(w), sn = -Math.sin(w);
    let zr = 1, zi = 0, re = 0, im = 0, total = 0;
    for (let t = from; t < to; t++) {
        const v = o[t];
        re += v * zr;
        im += v * zi;
        total += v;
        const nr = zr * cs - zi * sn;
        zi = zr * sn + zi * cs;
        zr = nr;
    }
    return total > 0 ? Math.sqrt(re * re + im * im) / total : 0;
}

// Picks the beat period (in frames). A Fourier tempogram alone tends to pick
// double tempo (off-beats) and autocorrelation alone half tempo (every other
// beat); the true beat is the one both agree on, so multiply them, with a
// broad preference for ~120 BPM to settle what's left.
function coarsePeriod(o, fps) {
    const n = o.length;
    const minBpm = 55, maxBpm = 215, bpmStep = 0.2;
    const maxLag = Math.ceil(fps * 60 / minBpm) + 2;
    if (n < maxLag * 2) return 0;

    const acf = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
        let acc = 0;
        for (let t = 0; t + lag < n; t++) acc += o[t] * o[t + lag];
        acf[lag] = acc / (n - lag);
    }
    if (acf[0] <= 0) return 0;

    // local (12 s windows) clarity, so slow drift or a different feel in one
    // section doesn't wipe out the peak
    const window = Math.min(n, Math.floor(fps * 12));
    const hop = Math.max(1, Math.floor(window / 2));

    let bestScore = -1, bestPeriod = 0;
    for (let i = 0; minBpm + i * bpmStep <= maxBpm; i++) {
        const bpm = minBpm + i * bpmStep;
        const period = fps * 60 / bpm;
        let clarity = 0, windows = 0;
        for (let from = 0; from + window <= n; from += hop) {
            clarity += pulseClarity(o, from, from + window, period);
            windows++;
        }
        clarity /= Math.max(1, windows);

        const lag = Math.floor(period);
        const frac = period - lag;
        const ac = (acf[lag] * (1 - frac) + acf[lag + 1] * frac) / acf[0];

        const octaves = Math.log2(bpm / 120);
        const score = clarity * Math.max(0, ac) * Math.exp(-0.5 * octaves * octaves);
        if (score > bestScore) {
            bestScore = score;
            bestPeriod = period;
        }
    }
    return bestPeriod;
}

// Fine-tunes the period by maximising the Fourier component of the whole onset
// envelope; its angle gives a first beat phase.
function refinePulse(o, p0) {
    const evaluate = (period) => {
        const w = 2 * Math.PI / period;
        const cs = Math.cos(w), sn = -Math.sin(w);
        let zr = 1, zi = 0, re = 0, im = 0;
        for (let t = 0; t < o.length; t++) {
            re += o[t] * zr;
            im += o[t] * zi;
            const nr = zr * cs - zi * sn;
            zi = zr * sn + zi * cs;
            zr = nr;
            if ((t & 1023) === 1023) {
                const m = Math.sqrt(zr * zr + zi * zi);
                zr /= m;
                zi /= m;
            }
        }
        return { re, im };
    };

    let best = p0, bestScore = -1;
    let lo = p0 * 0.985, hi = p0 * 1.015, steps = 120;
    for (let round = 0; round < 4; round++) {
        const step = (hi - lo) / steps;
        for (let i = 0; i <= steps; i++) {
            const p = lo + i * step;
            const { re, im } = evaluate(p);
            const s = re * re + im * im;
            if (s > bestScore) {
                bestScore = s;
                best = p;
            }
        }
        lo = best - 2 * step;
        hi = best + 2 * step;
        steps = 40;
    }

    const { re, im } = evaluate(best);
    let total = 0;
    for (let i = 0; i < o.length; i++) total += o[i];
    // pulses at t0 + k*P sum to K*e^(-i*w*t0), so t0 = -angle / w
    let phase = -Math.atan2(im, re) / (2 * Math.PI) * best;
    phase %= best;
    if (phase < 0) phase += best;
    return { period: best, phase, strength: total > 0 ? Math.sqrt(re * re + im * im) / total : 0 };
}

// Locks the grid onto the hits themselves: maximise the mean onset strength
// sampled exactly on the grid (a sharp comb) over a narrow range of periods and
// every phase. Unlike the Fourier angle, syncopated parts can't drag the phase
// towards the off-beats, and across a whole song the comb only stays on the
// hits if the period is right to a few hundredths of a percent.
function combRefine(o, rough) {
    // light smoothing so the comb can be sampled between frames
    const radius = 3;
    const kernel = [];
    let kernelSum = 0;
    for (let j = -radius; j <= radius; j++) {
        kernel.push(Math.exp(-0.5 * j * j));
        kernelSum += kernel[kernel.length - 1];
    }
    const s = new Float32Array(o.length);
    for (let t = 0; t < o.length; t++) {
        let acc = 0;
        for (let j = -radius; j <= radius; j++) {
            const i = t + j;
            if (i >= 0 && i < o.length) acc += kernel[j + radius] * o[i];
        }
        s[t] = acc / kernelSum;
    }

    const last = s.length - 1;
    const score = (period, phase) => {
        let sum = 0, count = 0;
        for (let t = phase; t < last; t += period) {
            const i = Math.floor(t), f = t - i;
            sum += s[i] * (1 - f) + s[i + 1] * f;
            count++;
        }
        return count ? sum / count : 0;
    };

    const best = { ...rough };
    let bestScore = -1;
    const search = (periodLo, periodHi, periodSteps, phaseLo, phaseHi, phaseStep) => {
        for (let i = 0; i <= periodSteps; i++) {
            const period = periodLo + (periodHi - periodLo) * i / periodSteps;
            for (let ph = phaseLo; ph < phaseHi; ph += phaseStep) {
                let wrapped = ph % period;
                if (wrapped < 0) wrapped += period;
                const v = score(period, wrapped);
                if (v > bestScore) {
                    bestScore = v;
                    best.period = period;
                    best.phase = wrapped;
                }
            }
        }
    };
    const span = rough.period * 0.004;
    search(rough.period - span, rough.period + span, 80, 0, rough.period, 0.25);
    const periodStep = 2 * span / 80;
    search(best.period - periodStep, best.period + periodStep, 20, best.phase - 0.3, best.phase + 0.3, 0.02);
    return best;
}

function computeChroma(x, rate) {
    const fps = rate / CHROMA_HOP;
    const timeOffset = (CHROMA_N / 2) / rate;

    // each bin maps to a MIDI note; notes get equal weight however many bins they cover
    const lowNote = 43;   // ~98 Hz
    const highNote = 99;  // ~4.98 kHz
    const bins = CHROMA_N / 2 + 1;
    const noteOfBin = new Int32Array(bins).fill(-1);
    for (let k = 1; k < bins; k++) {
        const freq = k * rate / CHROMA_N;
        const note = Math.round(69 + 12 * Math.log2(freq / 440));
        if (note >= lowNote && note <= highNote) noteOfBin[k] = note;
    }

    const frames = [];
    const notes = new Float64Array(128);
    forEachFrame(x, CHROMA_N, CHROMA_HOP, (f, mag) => {
        notes.fill(0);
        for (let k = 1; k < bins; k++) {
            const note = noteOfBin[k];
            if (note >= 0 && mag[k] > notes[note]) notes[note] = mag[k];
        }
        // a note's 3rd and 5th harmonics land a fifth and a third above it in
        // another octave and would read as extra notes, pulling the key a fifth
        // sharp; take their expected share out, lowest notes first
        for (let note = lowNote; note <= highNote; note++) {
            if (note + 19 <= highNote) notes[note + 19] = Math.max(0, notes[note + 19] - FIFTH_OVERTONE * notes[note]);
            if (note + 28 <= highNote) notes[note + 28] = Math.max(0, notes[note + 28] - THIRD_OVERTONE * notes[note]);
        }
        const c = new Float64Array(12);
        for (let note = lowNote; note <= highNote; note++) c[note % 12] += notes[note];
        frames.push(c);
    });
    return { frames, fps, timeOffset };
}

// Krumhansl-Kessler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) {
        ma += a[i];
        mb += b[i];
    }
    ma /= 12;
    mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function detectKey(chroma, info) {
    const total = new Float64Array(12);
    for (const c of chroma.frames) for (let i = 0; i < 12; i++) total[i] += c[i];
    let best = -2;
    for (let root = 0; root < 12; root++) {
        for (const minor of [false, true]) {
            const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
            const rotated = [];
            for (let pc = 0; pc < 12; pc++) rotated.push(profile[(pc - root + 12) % 12]);
            const r = correlate(total, rotated);
            if (r > best) {
                best = r;
                info.keyRoot = root;
                info.keyMinor = minor;
            }
        }
    }
    info.keyStrength = best;
}

function zNormalize(v) {
    if (!v.length) return;
    let mean = 0, variance = 0;
    for (const x of v) mean += x;
    mean /= v.length;
    for (const x of v) variance += (x - mean) ** 2;
    const sd = Math.sqrt(variance / v.length);
    for (let i = 0; i < v.length; i++) v[i] = sd > 1e-12 ? (v[i] - mean) / sd : 0;
}

// Bars start where the harmony changes, the energy jumps and the kick lands
// hardest, so score each of the four beat positions on those and take the best.
function chooseDownbeat(od, cd, period, phase, duration) {
    if (period <= 0) return 0;
    const beats = Math.floor(Math.max(0, (duration - phase) / period));
    if (beats < 16) return 0;

    const chroma = [], energy = new Float64Array(beats), kick = new Float64Array(beats);
    for (let b = 0; b < beats; b++) {
        const start = phase + b * period, end = start + period;
        const c = new Float64Array(12);
        const c0 = Math.ceil((start - cd.timeOffset) * cd.fps), c1 = Math.ceil((end - cd.timeOffset) * cd.fps);
        for (let f = Math.max(0, c0); f < c1 && f < cd.frames.length; f++) {
            for (let i = 0; i < 12; i++) c[i] += cd.frames[f][i];
        }
        chroma.push(c);

        const o0 = Math.ceil((start - od.timeOffset) * od.fps), o1 = Math.ceil((end - od.timeOffset) * od.fps);
        let count = 0;
        for (let f = Math.max(0, o0); f < o1 && f < od.energy.length; f++) {
            energy[b] += od.energy[f];
            count++;
        }
        if (count) energy[b] /= count;

        const centre = Math.round((start - od.timeOffset) * od.fps);
        for (let f = centre - 2; f <= centre + 2; f++) {
            if (f >= 0 && f < od.low.length) kick[b] = Math.max(kick[b], od.low[f]);
        }
    }

    const harmonic = [], lift = [], bass = [], index = [];
    for (let b = 2; b + 2 <= beats; b++) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < 12; i++) {
            const before = chroma[b - 2][i] + chroma[b - 1][i];
            const after = chroma[b][i] + chroma[b + 1][i];
            dot += before * after;
            na += before * before;
            nb += after * after;
        }
        harmonic.push(na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0);
        const eBefore = energy[b - 2] + energy[b - 1] + 1e-9;
        const eAfter = energy[b] + energy[b + 1] + 1e-9;
        lift.push(Math.max(0, Math.log(eAfter / eBefore)));
        bass.push(kick[b]);
        index.push(b);
    }
    zNormalize(harmonic);
    zNormalize(lift);
    zNormalize(bass);

    const score = [0, 0, 0, 0], count = [0, 0, 0, 0];
    for (let i = 0; i < index.length; i++) {
        const slot = index[i] % 4;
        score[slot] += harmonic[i] + lift[i] + 0.5 * bass[i];
        count[slot]++;
    }
    let best = 0;
    for (let slot = 1; slot < 4; slot++) {
        if (count[slot] && score[slot] / count[slot] > score[best] / Math.max(1, count[best])) best = slot;
    }
    return best;
}

function wrapSemitones(s) {
    s = ((s % 12) + 12) % 12;
    return s > 6 ? s - 12 : s;
}

function relativeMajor(t) {
    return t.keyMinor ? (t.keyRoot + 3) % 12 : t.keyRoot;
}

export function bpm(info) {
    return 60 / info.beatPeriod;
}

export function firstDownbeat(info) {
    return info.beatPhase + info.downbeat * info.beatPeriod;
}

// first bar start at or after t (may be before 0 when t is)
export function downbeatAtOrAfter(info, t) {
    const bar = 4 * info.beatPeriod;
    const first = firstDownbeat(info);
    return first + Math.ceil((t - first) / bar - 1e-9) * bar;
}

export function analyzeTrack(mono, sampleRate) {
    const info = {
        duration: mono.length / sampleRate,
        beatPeriod: 0.5,
        beatPhase: 0,
        downbeat: 0,
        tempoStrength: 0,
        keyRoot: 0,
        keyMinor: false,
        keyStrength: 0,
    };
    if (!(sampleRate > 0) || info.duration < 4) return info;

    const { x, rate } = downsample(mono, sampleRate);
    const onsets = computeOnsets(x, rate);
    const chroma = computeChroma(x, rate);
    detectKey(chroma, info);

    const p0 = coarsePeriod(onsets.onset, onsets.fps);
    if (p0 <= 0) return info;
    const pulse = combRefine(onsets.onset, refinePulse(onsets.onset, p0));

    info.beatPeriod = pulse.period / onsets.fps;
    info.tempoStrength = pulse.strength;
    let phase = (pulse.phase / onsets.fps + onsets.timeOffset) % info.beatPeriod;
    if (phase < 0) phase += info.beatPeriod;
    info.beatPhase = phase;
    info.downbeat = chooseDownbeat(onsets, chroma, info.beatPeriod, info.beatPhase, info.duration);
    return info;
}

export const defaultPlanOptions = {
    songStart: 0,        // song time to line the freestyle up from
    rttSkip: 0,          // seconds of the freestyle to skip before lining up
    beatShift: 0,        // slide the freestyle by whole beats
    matchKey: true,
    preservePitch: true,
    loop: true,
};

// How to play the freestyle against the song: its playback speed, pitch
// correction and which of its bars lines up with which of the song's.
export function planMashup(song, rtt, options = {}) {
    const o = { ...defaultPlanOptions, ...options };
    const plan = {
        speed: 1,         // freestyle playback rate (its tempo matched to the song)
        pitch: 1,         // pitch-shift factor applied on top of the rate change
        semitones: 0,     // net transposition of the freestyle
        songAnchor: 0,    // song time of the bar the freestyle locks to
        rttAnchor: 0,     // freestyle time that plays at songAnchor
        rttStart: Math.max(0, o.rttSkip),
        loopStart: 0,
        loopLength: 0,    // 0 = no loop
        rttDuration: rtt.duration,
    };

    // match tempos, folding by octaves so neither track is stretched more than ~41%
    let speed = rtt.beatPeriod / song.beatPeriod;
    while (speed > Math.SQRT2) speed *= 0.5;
    while (speed < Math.SQRT1_2) speed *= 2;
    plan.speed = speed;

    // speeding up raises the pitch by this much on its own
    const rateShift = 12 * Math.log2(speed);

    if (o.preservePitch) {
        let semitones = 0;
        if (o.matchKey && song.keyStrength >= MIN_KEY_STRENGTH && rtt.keyStrength >= MIN_KEY_STRENGTH) {
            const same = wrapSemitones(relativeMajor(song) - relativeMajor(rtt));
            // a fifth either way also sits well (neighbours on the circle of fifths);
            // take whichever needs the least pitch-shifting
            let bestCost = Infinity;
            for (const candidate of [same, wrapSemitones(same + 7), wrapSemitones(same - 7)]) {
                const cost = Math.abs(candidate - rateShift) + (candidate === same ? 0 : 1.5);
                if (cost < bestCost) {
                    bestCost = cost;
                    semitones = candidate;
                }
            }
        }
        plan.semitones = semitones;
        plan.pitch = Math.pow(2, (semitones - rateShift) / 12);
    }
    else {
        plan.semitones = Math.round(rateShift);
        plan.pitch = 1;
    }

    plan.songAnchor = downbeatAtOrAfter(song, o.songStart);
    plan.rttAnchor = downbeatAtOrAfter(rtt, plan.rttStart) + o.beatShift * rtt.beatPeriod;

    if (o.loop) {
        const bar = 4 * rtt.beatPeriod;
        let start = plan.rttAnchor;
        if (start < plan.rttStart) start += Math.ceil((plan.rttStart - start) / bar) * bar;
        const available = rtt.duration - start;
        const phrase = 4 * bar;
        let length = Math.floor(available / phrase) * phrase;
        if (length < phrase) length = Math.floor(available / bar) * bar;
        if (length >= bar) {
            plan.loopStart = start;
            plan.loopLength = length;
        }
    }
    return plan;
}

// freestyle position for a song position; < 0 means not started yet,
// >= rttDuration means it has finished
export function rttTime(plan, songTime) {
    let t = plan.rttAnchor + (songTime - plan.songAnchor) * plan.speed;
    if (t < plan.rttStart) return -1;
    if (plan.loopLength > 0 && t >= plan.loopStart + plan.loopLength) {
        t = plan.loopStart + ((t - plan.loopStart) % plan.loopLength);
    }
    return t;
}

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

export function keyName(root, minor) {
    const r = ((root % 12) + 12) % 12;
    return minor ? MINOR_NAMES[r] : MAJOR_NAMES[r];
}
