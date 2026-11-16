// Download formats. MP3 and Ogg use the LAME and Vorbis encoders compiled to
// WebAssembly (wasm-media-encoders, MIT), fetched only when one is picked.

import { encodeFlac } from './flac.js';
import { encodeWav } from './mashup.js';

const MEDIA_ENCODERS = 'https://cdn.jsdelivr.net/npm/wasm-media-encoders@0.7.0/dist/esnext/index.mjs';

export const FORMATS = {
    'mp3-320': { label: 'MP3 · 320 kbps', ext: 'mp3', mime: 'audio/mpeg', codec: 'mp3', options: { bitrate: 320 } },
    'mp3-192': { label: 'MP3 · 192 kbps', ext: 'mp3', mime: 'audio/mpeg', codec: 'mp3', options: { bitrate: 192 } },
    'mp3-128': { label: 'MP3 · 128 kbps (smallest)', ext: 'mp3', mime: 'audio/mpeg', codec: 'mp3', options: { bitrate: 128 } },
    ogg: { label: 'Ogg Vorbis · high quality', ext: 'ogg', mime: 'audio/ogg', codec: 'ogg', options: { vbrQuality: 6 } },
    flac: { label: 'FLAC · lossless', ext: 'flac', mime: 'audio/flac', codec: 'flac' },
    wav: { label: 'WAV · lossless, uncompressed', ext: 'wav', mime: 'audio/wav', codec: 'wav' },
};

export const DEFAULT_FORMAT = 'mp3-320';

let mediaEncoders = null;

async function encodeLossy(codec, options, channels, sampleRate, onProgress) {
    mediaEncoders ??= import(MEDIA_ENCODERS).catch((error) => {
        mediaEncoders = null;
        throw new Error(`couldn't load the ${codec.toUpperCase()} encoder (are you offline?)`, { cause: error });
    });
    const { createMp3Encoder, createOggEncoder } = await mediaEncoders;
    const encoder = await (codec === 'mp3' ? createMp3Encoder() : createOggEncoder());
    encoder.configure({ sampleRate, channels: channels.length, ...options });

    // the encoder owns the returned bytes, so copy each piece out
    const parts = [];
    let size = 0;
    const length = channels[0].length, chunk = 1 << 16;
    for (let i = 0; i < length; i += chunk) {
        const out = encoder.encode(channels.map((c) => c.subarray(i, i + chunk)));
        parts.push(out.slice());
        size += out.length;
        onProgress?.(i / length);
    }
    const tail = encoder.finalize();
    parts.push(tail.slice());
    size += tail.length;

    const file = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        file.set(part, offset);
        offset += part.length;
    }
    return file;
}

// returns an ArrayBuffer holding the whole file
export async function encode(format, channels, sampleRate, onProgress) {
    const f = FORMATS[format];
    if (!f) throw new Error(`unknown format ${format}`);
    if (f.codec === 'wav') return encodeWav(channels, sampleRate);
    if (f.codec === 'flac') return encodeFlac(channels, sampleRate, onProgress).buffer;
    return (await encodeLossy(f.codec, f.options, channels, sampleRate, onProgress)).buffer;
}
