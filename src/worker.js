// Does the heavy lifting off the page's main thread: analyses each track once,
// renders mashups from them as settings change, and encodes downloads.

import { analyzeTrack } from './analysis.js';
import { renderMashup, encodeWav } from './mashup.js';
import { encode } from './formats.js';

const tracks = {};
let lastMix = null;

function mono(channels) {
    if (channels.length === 1) return channels[0];
    const out = new Float32Array(channels[0].length);
    for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
    return out;
}

self.onmessage = async (event) => {
    const { id, type } = event.data;
    const reply = (data, transfer = []) => self.postMessage({ id, ...data }, transfer);
    try {
        if (type === 'load') {
            const { which, sampleRate, channels } = event.data;
            const audio = { sampleRate, channels };
            const info = analyzeTrack(mono(channels), sampleRate);
            tracks[which] = { audio, info };
            reply({ type: 'done', info });
        }
        else if (type === 'render') {
            const { song, rtt } = tracks;
            if (!song || !rtt) throw new Error('Load both files first.');
            const result = renderMashup({
                song: song.audio,
                rtt: rtt.audio,
                songInfo: song.info,
                rttInfo: rtt.info,
                settings: event.data.settings,
                onProgress: (stage, fraction) => reply({ type: 'progress', stage, fraction }),
            });
            lastMix = { channels: result.channels, sampleRate: result.sampleRate };
            // WAV for the in-page player: instant, and plays everywhere
            const wav = encodeWav(result.channels, result.sampleRate);
            reply({ type: 'done', plan: result.plan, songInfo: song.info, rttInfo: rtt.info, wav }, [wav]);
        }
        else if (type === 'encode') {
            if (!lastMix) throw new Error('Make a mashup first.');
            const data = await encode(event.data.format, lastMix.channels, lastMix.sampleRate, (fraction) => reply({ type: 'progress', stage: 'Encoding', fraction }));
            reply({ type: 'done', data }, [data]);
        }
    }
    catch (error) {
        reply({ type: 'error', message: error?.message || String(error) });
    }
};
