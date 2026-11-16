// Renders a mashup: the freestyle time-stretched to the song's tempo, shifted
// into a fitting key, lined up bar for bar and mixed over the song.
// Audio is { sampleRate, channels: Float32Array[] }.

import { planMashup, rttTime } from './analysis.js';

export const defaultSettings = {
    rttVolume: 1,
    songVolume: 1,
    bassCut: 150,      // Hz high-pass on the freestyle; 0 = off
    matchKey: true,
    keepPitch: true,
    loop: true,
    rttSkip: 0,        // seconds
    beatShift: 0,      // beats
    offsetMs: 0,       // positive plays the freestyle earlier
};

// Plays `channels` `speed` times faster without changing pitch (WSOLA: overlap
// short grains, each nudged by up to ~8 ms to where it best continues the last,
// which keeps drums and vocals crisp).
export function stretch(channels, speed, sampleRate, onProgress) {
    if (Math.abs(speed - 1) < 1e-4) return channels;
    const frame = 2 * Math.round(sampleRate * 0.023);
    const hop = frame / 2;
    const tolerance = Math.round(sampleRate * 0.008);
    const inLen = channels[0].length;
    const outLen = Math.floor(inLen / speed);

    const window = new Float32Array(frame);
    for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);

    // grains are matched on a mono mix, coarsely at 1/8 rate then exactly
    const mono = new Float32Array(inLen);
    for (const ch of channels) for (let i = 0; i < inLen; i++) mono[i] += ch[i] / channels.length;
    const D = 8;
    const coarse = new Float32Array(Math.ceil(inLen / D));
    for (let i = 0; i < inLen; i++) coarse[(i / D) | 0] += mono[i] / D;
    const energyPrefix = (x) => {
        const p = new Float64Array(x.length + 1);
        for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i] * x[i];
        return p;
    };
    const coarseEnergy = energyPrefix(coarse), monoEnergy = energyPrefix(mono);

    // correlation of the half-frame ending at `a` with the one ending at `b`,
    // normalised by b's energy
    const similarity = (x, energy, a, b, len) => {
        if (a - len < 0 || b - len < 0 || a > x.length || b > x.length) return -Infinity;
        let dot = 0;
        const oa = a - len, ob = b - len;
        for (let j = 0; j < len; j++) dot += x[oa + j] * x[ob + j];
        return dot / Math.sqrt(energy[b] - energy[ob] + 1e-9);
    };

    // output is padded by half a frame so frame k is centred on output sample k*hop
    const out = channels.map(() => new Float32Array(outLen + frame));
    let prevCentre = 0;
    const frames = Math.ceil(outLen / hop) + 1;
    for (let k = 0; k < frames; k++) {
        const nominal = Math.round(k * hop * speed);
        let centre = nominal;
        if (k > 0) {
            // what would continue the previous grain seamlessly
            const natural = prevCentre + hop;
            let best = nominal, bestScore = -Infinity;
            const c = Math.round(natural / D), half = Math.round(hop / D);
            for (let d = -tolerance; d <= tolerance; d += D) {
                const s = similarity(coarse, coarseEnergy, c, Math.round((nominal + d) / D), half);
                if (s > bestScore) {
                    bestScore = s;
                    best = nominal + d;
                }
            }
            bestScore = -Infinity;
            const around = best;
            for (let d = -D / 2; d <= D / 2; d++) {
                const s = similarity(mono, monoEnergy, natural, around + d, hop);
                if (s > bestScore) {
                    bestScore = s;
                    best = around + d;
                }
            }
            if (bestScore > -Infinity) centre = best;
        }
        const src = centre - hop;
        const dst = k * hop;
        for (let c = 0; c < channels.length; c++) {
            const x = channels[c], o = out[c];
            const from = Math.max(0, -src), to = Math.min(frame, inLen - src, o.length - dst);
            for (let i = from; i < to; i++) o[dst + i] += window[i] * x[src + i];
        }
        prevCentre = centre;
        if (onProgress && (k & 255) === 0) onProgress(k / frames);
    }
    return out.map((o) => o.slice(hop, hop + outLen));
}

// Plays `channels` `speed` times faster (changing pitch too), band-limited so
// speeding up doesn't alias.
export function resample(channels, speed, onProgress) {
    if (Math.abs(speed - 1) < 1e-7) return channels;
    const halfTaps = 16, taps = 2 * halfTaps, phases = 512;
    const cutoff = Math.min(1, 1 / speed) * 0.97;
    const table = new Float32Array((phases + 1) * taps);
    for (let p = 0; p <= phases; p++) {
        for (let j = 0; j < taps; j++) {
            const x = (j - halfTaps + 1) - p / phases;
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
            const w = Math.abs(x) >= halfTaps ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x / halfTaps) + 0.08 * Math.cos(2 * Math.PI * x / halfTaps);
            table[p * taps + j] = cutoff * sinc * w;
        }
    }

    const inLen = channels[0].length;
    const outLen = Math.floor(inLen / speed);
    return channels.map((x, c) => {
        const out = new Float32Array(outLen);
        for (let n = 0; n < outLen; n++) {
            const pos = n * speed;
            const i0 = Math.floor(pos);
            const base = Math.round((pos - i0) * phases) * taps;
            const first = i0 - halfTaps + 1;
            let acc = 0;
            if (first >= 0 && first + taps <= inLen) {
                for (let j = 0; j < taps; j++) acc += x[first + j] * table[base + j];
            }
            else {
                for (let j = 0; j < taps; j++) {
                    const i = first + j;
                    if (i >= 0 && i < inLen) acc += x[i] * table[base + j];
                }
            }
            out[n] = acc;
            if (onProgress && (n & 0x3ffff) === 0) onProgress((c + n / outLen) / channels.length);
        }
        return out;
    });
}

// 24 dB/octave Butterworth high-pass, in place
function highpass(x, cutoff, sampleRate) {
    for (const q of [0.5412, 1.3066]) {
        const w0 = 2 * Math.PI * cutoff / sampleRate;
        const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = b0;
        const a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
        let z1 = 0, z2 = 0;
        for (let i = 0; i < x.length; i++) {
            const input = x[i];
            const output = b0 * input + z1;
            z1 = b1 * input - a1 * output + z2;
            z2 = b2 * input - a2 * output;
            x[i] = output;
        }
    }
}

// Lays the processed freestyle onto the song's timeline, following the plan's
// bar alignment and loop, with short crossfades wherever it jumps.
function placeFreestyle(processed, plan, length, sampleRate, offset) {
    const out = processed.map(() => new Float32Array(length));
    const scale = sampleRate / plan.speed;  // processed samples per freestyle second
    const fade = Math.round(sampleRate * 0.01);
    const size = processed[0].length;
    const at = (c, pos) => (pos >= 0 && pos < size ? processed[c][pos] : 0);

    let prev = -1, fadeFrom = -1, fadeLeft = 0, fadeIn = 0;
    for (let n = 0; n < length; n++) {
        const tau = rttTime(plan, n / sampleRate + offset);
        const audible = tau >= 0 && tau < plan.rttDuration;
        const pos = audible ? Math.round(tau * scale) : -1;
        if (audible && prev < 0) fadeIn = fade;
        else if (audible && Math.abs(pos - prev - 1) > 1) {
            // loop jump: fade out the old continuation while the new one fades in
            fadeFrom = prev + 1;
            fadeLeft = fade;
        }
        if (audible || fadeLeft > 0) {
            const gainIn = fadeIn > 0 ? 1 - fadeIn / fade : 1;
            const w = fadeLeft > 0 ? fadeLeft / fade : 0;
            for (let c = 0; c < out.length; c++) {
                const now = audible ? at(c, pos) * gainIn : 0;
                out[c][n] = fadeLeft > 0 ? now * (1 - w) + at(c, fadeFrom) * w : now;
            }
            if (fadeLeft > 0) {
                fadeFrom++;
                fadeLeft--;
            }
            if (fadeIn > 0) fadeIn--;
        }
        prev = pos;
    }
    return out;
}

// Returns { channels: [left, right], sampleRate, plan, stems: { song, freestyle } }.
export function renderMashup({ song, rtt, songInfo, rttInfo, settings = {}, onProgress = () => {} }) {
    const s = { ...defaultSettings, ...settings };
    const rate = song.sampleRate;
    const plan = planMashup(songInfo, rttInfo, {
        rttSkip: s.rttSkip,
        beatShift: s.beatShift,
        matchKey: s.matchKey,
        preservePitch: s.keepPitch,
        loop: s.loop,
    });

    // Net effect wanted: tempo x speed, pitch x (speed * pitch). Stretch without
    // changing pitch by 1/pitch, then resample (which moves both) by
    // speed * pitch, folding in any sample-rate difference.
    const pitchFactor = plan.speed * plan.pitch;
    onProgress('Stretching the freestyle', 0);
    const stretched = stretch(rtt.channels, 1 / plan.pitch, rtt.sampleRate, (f) => onProgress('Stretching the freestyle', f));
    onProgress('Shifting key', 0);
    const processed = resample(stretched, pitchFactor * rtt.sampleRate / rate, (f) => onProgress('Shifting key', f));
    if (s.bassCut > 0) for (const ch of processed) highpass(ch, s.bassCut, rate);

    onProgress('Mixing', 0);
    const length = song.channels[0].length;
    const freestyle = placeFreestyle(processed, plan, length, rate, s.offsetMs / 1000);

    const pick = (chs, c) => chs[Math.min(c, chs.length - 1)];
    const channels = [0, 1].map((c) => {
        const a = pick(song.channels, c), b = pick(freestyle, c);
        const out = new Float32Array(length);
        for (let i = 0; i < length; i++) out[i] = a[i] * s.songVolume + b[i] * s.rttVolume;
        return out;
    });
    let peak = 0;
    for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    if (peak > 0.98) {
        const gain = 0.98 / peak;
        for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
    }
    onProgress('Mixing', 1);
    return { channels, sampleRate: rate, plan, stems: { song: song.channels, freestyle } };
}

// 16-bit PCM WAV
export function encodeWav(channels, sampleRate) {
    const n = channels[0].length, count = channels.length;
    const buffer = new ArrayBuffer(44 + n * count * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + n * count * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * count * 2, true);
    view.setUint16(32, count * 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, n * count * 2, true);
    let offset = 44;
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < count; c++) {
            const v = Math.max(-1, Math.min(1, channels[c][i]));
            view.setInt16(offset, Math.round(v * 32767), true);
            offset += 2;
        }
    }
    return buffer;
}
