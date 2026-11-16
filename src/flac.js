// Lossless FLAC encoder for 16-bit audio: fixed linear predictors, Rice-coded
// residuals and the best stereo decorrelation per frame. Typically about half
// the size of WAV.

const BLOCK_SIZE = 4096;
const MAX_PARTITION_ORDER = 8;

class BitWriter {
    constructor(bytes) {
        this.buf = new Uint8Array(bytes);
        this.length = 0;
        this.acc = 0;
        this.bits = 0;
    }

    pushByte(b) {
        if (this.length === this.buf.length) {
            const bigger = new Uint8Array(this.buf.length * 2);
            bigger.set(this.buf);
            this.buf = bigger;
        }
        this.buf[this.length++] = b;
    }

    // writes the low `count` bits of value (two's complement for negatives)
    write(value, count) {
        if (count > 24) {
            this.write(Math.floor(value / 65536), count - 16);
            this.write(value & 0xffff, 16);
            return;
        }
        if (count === 0) return;
        this.acc = (this.acc << count) | (value & ((1 << count) - 1));
        this.bits += count;
        while (this.bits >= 8) {
            this.bits -= 8;
            this.pushByte((this.acc >>> this.bits) & 0xff);
        }
        this.acc &= (1 << this.bits) - 1;
    }

    // q zero bits, a one, then the low k bits of low
    writeRice(q, k, low) {
        while (q + 1 + k > 24) {
            const zeros = Math.min(q, 24);
            this.write(0, zeros);
            q -= zeros;
            if (q === 0 && 1 + k > 24) {
                this.write(1, 1);
                this.write(low, k);
                return;
            }
        }
        this.write((1 << k) | (low & ((1 << k) - 1)), q + 1 + k);
    }

    align() {
        if (this.bits) this.write(0, 8 - this.bits);
    }

    bytes() {
        return this.buf.subarray(0, this.length);
    }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    CRC8[i] = c;
    let d = i << 8;
    for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
    CRC16[i] = d;
}

function crc8(bytes, from, to) {
    let c = 0;
    for (let i = from; i < to; i++) c = CRC8[c ^ bytes[i]];
    return c;
}

function crc16(bytes, from, to) {
    let c = 0;
    for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ bytes[i]];
    return c;
}

// frame numbers are written UTF-8 style
function writeCodedNumber(w, v) {
    if (v < 0x80) return w.write(v, 8);
    const bytes = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
    w.write((0xff00 >> bytes) & 0xff | (v >>> (6 * (bytes - 1))), 8);
    for (let i = bytes - 2; i >= 0; i--) w.write(0x80 | ((v >>> (6 * i)) & 0x3f), 8);
}

// residual of the fixed predictor of the given order, zigzag-encoded
function residual(x, n, order, out) {
    for (let i = order; i < n; i++) {
        let e;
        switch (order) {
            case 0: e = x[i]; break;
            case 1: e = x[i] - x[i - 1]; break;
            case 2: e = x[i] - 2 * x[i - 1] + x[i - 2]; break;
            case 3: e = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
            default: e = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
        }
        out[i] = e >= 0 ? 2 * e : -2 * e - 1;
    }
}

// cheapest fixed predictor order by summed residual size
function bestOrder(x, n, scratch) {
    let best = 0, bestSum = Infinity;
    for (let order = 0; order <= 4 && order < n; order++) {
        residual(x, n, order, scratch);
        let sum = 0;
        for (let i = order; i < n; i++) sum += scratch[i];
        if (sum < bestSum) {
            bestSum = sum;
            best = order;
        }
    }
    return { order: best, sum: bestSum };
}

function riceParam(sum, count) {
    if (count === 0 || sum <= count) return 0;
    return Math.min(30, Math.floor(Math.log2(sum / count)));
}

// picks the partition order and per-partition Rice parameters (estimated cost)
function planPartitions(u, n, order) {
    let best = null;
    for (let p = 0; p <= MAX_PARTITION_ORDER; p++) {
        const parts = 1 << p;
        if (n % parts || (n >> p) <= order) break;
        const size = n >> p;
        const params = [];
        let bits = 0;
        for (let part = 0; part < parts; part++) {
            const from = part === 0 ? order : part * size, to = (part + 1) * size;
            let sum = 0;
            for (let i = from; i < to; i++) sum += u[i];
            const count = to - from;
            let k = riceParam(sum, count);
            // check the neighbours of the estimate
            let cost = Infinity;
            for (const c of [k - 1, k, k + 1]) {
                if (c < 0 || c > 30) continue;
                const est = count * (c + 1) + Math.floor(sum / 2 ** c);
                if (est < cost) {
                    cost = est;
                    k = c;
                }
            }
            params.push(k);
            bits += cost + 5;
        }
        if (!best || bits < best.bits) best = { p, params, bits };
    }
    return best;
}

function writeSubframe(w, x, n, bps, scratch) {
    let constant = true;
    for (let i = 1; i < n && constant; i++) constant = x[i] === x[0];
    if (constant) {
        w.write(0, 8);
        w.write(x[0], bps);
        return;
    }

    const { order } = bestOrder(x, n, scratch);
    residual(x, n, order, scratch);
    const plan = planPartitions(scratch, n, order);
    if (!plan || plan.bits + order * bps >= n * bps) {
        // verbatim
        w.write(0b00000010, 8);
        for (let i = 0; i < n; i++) w.write(x[i], bps);
        return;
    }

    w.write(0b00010000 | (order << 1), 8);
    for (let i = 0; i < order; i++) w.write(x[i], bps);
    const rice2 = plan.params.some((k) => k > 14);
    w.write(rice2 ? 1 : 0, 2);
    w.write(plan.p, 4);
    const size = n >> plan.p;
    for (let part = 0; part < plan.params.length; part++) {
        const k = plan.params[part];
        w.write(k, rice2 ? 5 : 4);
        const from = part === 0 ? order : part * size, to = (part + 1) * size;
        for (let i = from; i < to; i++) {
            const v = scratch[i];
            w.writeRice(Math.floor(v / 2 ** k), k, v % 2 ** k);
        }
    }
}

function toInt16(channel) {
    const out = new Int32Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, channel[i])) * 32767);
    return out;
}

const SAMPLE_RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

// channels: Float32Array[] (1 or 2). Returns a Uint8Array .flac file.
export function encodeFlac(channels, sampleRate, onProgress) {
    const pcm = channels.map(toInt16);
    const count = pcm.length;
    const total = pcm[0].length;
    const w = new BitWriter(Math.max(1024, total * count * 2 + 1024));

    w.write(0x664c6143, 32); // "fLaC"
    w.write(1, 1); // last metadata block
    w.write(0, 7); // STREAMINFO
    w.write(34, 24);
    w.write(Math.min(BLOCK_SIZE, Math.max(16, total)), 16);
    w.write(Math.min(BLOCK_SIZE, Math.max(16, total)), 16);
    w.write(0, 24); // min/max frame size unknown
    w.write(0, 24);
    w.write(sampleRate, 20);
    w.write(count - 1, 3);
    w.write(15, 5); // 16 bits per sample
    w.write(Math.floor(total / 2 ** 32), 4);
    w.write(total >>> 0, 32);
    for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 not computed

    const scratch = new Int32Array(BLOCK_SIZE);
    const mid = new Int32Array(BLOCK_SIZE), side = new Int32Array(BLOCK_SIZE);
    const frames = Math.ceil(total / BLOCK_SIZE);
    for (let frame = 0; frame < frames; frame++) {
        const start = frame * BLOCK_SIZE;
        const n = Math.min(BLOCK_SIZE, total - start);
        const blocks = pcm.map((ch) => ch.subarray(start, start + n));

        // stereo: whichever of L+R, L+S, S+R, M+S codes smallest. Costs are
        // estimated bits capped at the raw size, so incompressible blocks stay
        // L+R: some decoders (CoreAudio) reject frames bigger than raw PCM.
        let assignment = count - 1, subframes = blocks.map((b) => [b, 16]);
        if (count === 2) {
            const [l, r] = blocks;
            for (let i = 0; i < n; i++) {
                side[i] = l[i] - r[i];
                mid[i] = (l[i] + r[i]) >> 1;
            }
            const cost = (x, bps) => {
                const { order, sum } = bestOrder(x, n, scratch);
                const k = riceParam(sum, n - order);
                return Math.min(n * bps, order * bps + (n - order) * (k + 1) + sum / 2 ** k);
            };
            const cl = cost(l, 16), cr = cost(r, 16), cs = cost(side.subarray(0, n), 17), cm = cost(mid.subarray(0, n), 16);
            const options = [
                [cl + cr, 1, [[l, 16], [r, 16]]],
                [cl + cs, 8, [[l, 16], [side.subarray(0, n), 17]]],
                [cs + cr, 9, [[side.subarray(0, n), 17], [r, 16]]],
                [cm + cs, 10, [[mid.subarray(0, n), 16], [side.subarray(0, n), 17]]],
            ];
            options.sort((a, b) => a[0] - b[0]);
            assignment = options[0][1];
            subframes = options[0][2];
        }

        const frameStart = w.length;
        w.write(0b11111111111110, 14);
        w.write(0, 1);
        w.write(0, 1); // fixed block size
        const fullBlock = n === BLOCK_SIZE;
        w.write(fullBlock ? 12 : 7, 4);
        w.write(SAMPLE_RATE_CODES[sampleRate] ?? 0, 4);
        w.write(assignment, 4);
        w.write(0b100, 3); // 16 bits per sample
        w.write(0, 1);
        writeCodedNumber(w, frame);
        if (!fullBlock) w.write(n - 1, 16);
        w.write(crc8(w.buf, frameStart, w.length), 8);

        for (const [samples, bps] of subframes) writeSubframe(w, samples, n, bps, scratch);
        w.align();
        w.write(crc16(w.buf, frameStart, w.length), 16);
        if (onProgress && (frame & 63) === 0) onProgress(frame / frames);
    }
    return w.bytes().slice();
}
