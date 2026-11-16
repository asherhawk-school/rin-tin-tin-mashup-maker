// Does the heavy lifting off the page's main thread: analyses each track once,
// then renders mashups from them as settings change.

import { analyzeTrack } from './analysis.js';
import { renderMashup, encodeWav } from './mashup.js';

const tracks = {};

function mono(channels) {
    if (channels.length === 1) return channels[0];
    const out = new Float32Array(channels[0].length);
    for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
    return out;
}

self.onmessage = (event) => {
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
            const wav = encodeWav(result.channels, result.sampleRate);
            reply({ type: 'done', plan: result.plan, songInfo: song.info, rttInfo: rtt.info, wav }, [wav]);
        }
    }
    catch (error) {
        reply({ type: 'error', message: error?.message || String(error) });
    }
};
