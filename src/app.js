import { bpm, keyName } from './analysis.js';
import { defaultSettings } from './mashup.js';

// everything is decoded at one rate so the two tracks line up sample for sample
const SAMPLE_RATE = 44100;
const SETTINGS_KEY = 'rtt-mashup-settings';
const REMEMBER_KEY = 'rtt-mashup-remember';

// ---- worker ----

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;

worker.onmessage = (event) => {
    const { id, type } = event.data;
    const request = pending.get(id);
    if (!request) return;
    if (type === 'progress') {
        request.onProgress?.(event.data);
        return;
    }
    pending.delete(id);
    if (type === 'error') request.reject(new Error(event.data.message));
    else request.resolve(event.data);
};

function ask(message, transfer = [], onProgress) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, ...message }, transfer);
    });
}

// ---- remembering the freestyle (IndexedDB, best effort) ----

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('rtt-mashup', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function storeFile(value) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readwrite');
            if (value) tx.objectStore('files').put(value, 'freestyle');
            else tx.objectStore('files').delete('freestyle');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }
    catch (error) {
        console.warn('could not update the remembered freestyle', error);
    }
}

async function rememberedFreestyle() {
    try {
        const db = await openDb();
        const saved = await new Promise((resolve, reject) => {
            const request = db.transaction('files').objectStore('files').get('freestyle');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return saved ? new File([saved.blob], saved.name, { type: saved.blob.type }) : null;
    }
    catch {
        return null;
    }
}

function readLocal(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

function writeLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        // private mode etc.; settings just won't stick
    }
}

// ---- tracks ----

const tracks = { rtt: null, song: null };
const tokens = { rtt: 0, song: 0 };
const cards = {
    rtt: document.querySelector('[data-which="rtt"]'),
    song: document.querySelector('[data-which="song"]'),
};
const rememberBox = document.getElementById('remember');

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function showTrack(which, { name = null, facts = '', bad = false } = {}) {
    const card = cards[which];
    card.querySelector('.zone').hidden = name !== null;
    card.querySelector('.loaded').hidden = name === null;
    card.querySelector('.file-name').textContent = name ?? '';
    const factsEl = card.querySelector('.facts');
    factsEl.textContent = facts;
    factsEl.classList.toggle('bad', bad);
}

async function decode(file) {
    const data = await file.arrayBuffer();
    const context = new OfflineAudioContext(2, 1, SAMPLE_RATE);
    return context.decodeAudioData(data);
}

async function load(which, file) {
    const token = ++tokens[which];
    tracks[which] = null;
    markChanged();
    showTrack(which, { name: file.name, facts: 'Decoding…' });
    try {
        const buffer = await decode(file);
        if (token !== tokens[which]) return;
        showTrack(which, { name: file.name, facts: 'Finding the beat and key…' });
        const channels = [];
        for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
        const { info } = await ask(
            { type: 'load', which, sampleRate: buffer.sampleRate, channels },
            channels.map((c) => c.buffer),
        );
        if (token !== tokens[which]) return;
        tracks[which] = { name: file.name, info, file };
        showTrack(which, {
            name: file.name,
            facts: `${bpm(info).toFixed(1)} BPM · ${keyName(info.keyRoot, info.keyMinor)} · ${formatTime(info.duration)}`,
        });
        if (which === 'rtt' && rememberBox.checked) storeFile({ name: file.name, blob: file });
    }
    catch (error) {
        if (token !== tokens[which]) return;
        console.error(error);
        showTrack(which, { name: file.name, facts: "Couldn't read this file. Try an mp3, wav, ogg or flac.", bad: true });
    }
    updateMake();
}

for (const [which, card] of Object.entries(cards)) {
    const zone = card.querySelector('.zone');
    const input = zone.querySelector('input');
    input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';
        if (file) load(which, file);
    });
    zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        const file = event.dataTransfer.files[0];
        if (file) load(which, file);
    });
    card.querySelector('.change').addEventListener('click', () => input.click());
}

rememberBox.checked = readLocal(REMEMBER_KEY, true);
rememberBox.addEventListener('change', () => {
    writeLocal(REMEMBER_KEY, rememberBox.checked);
    // the file itself is only kept while the box is ticked
    const file = tracks.rtt?.file;
    storeFile(rememberBox.checked && file ? { name: file.name, blob: file } : null);
});

// ---- settings ----

const controls = document.querySelector('.controls');
const formats = {
    rttVolume: (v) => `${Math.round(v * 100)}%`,
    songVolume: (v) => `${Math.round(v * 100)}%`,
    bassCut: (v) => (v > 0 ? `${v} Hz` : 'Off'),
    rttSkip: (v) => `${v} s`,
    beatShift: (v) => `${v > 0 ? '+' : ''}${v} beat${Math.abs(v) === 1 ? '' : 's'}`,
    offsetMs: (v) => `${v > 0 ? '+' : ''}${v} ms`,
};

function readSettings() {
    const settings = {};
    for (const input of controls.querySelectorAll('input')) {
        settings[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value);
    }
    return settings;
}

function showSettings(settings) {
    for (const input of controls.querySelectorAll('input')) {
        if (!(input.name in settings)) continue;
        if (input.type === 'checkbox') input.checked = settings[input.name];
        else input.value = settings[input.name];
    }
    refreshSettings();
}

function refreshSettings() {
    for (const input of controls.querySelectorAll('input[type="range"]')) {
        input.parentElement.querySelector('output').textContent = formats[input.name](Number(input.value));
    }
    // key matching relies on pitch correction
    const keepPitch = controls.querySelector('[name="keepPitch"]').checked;
    const matchKey = controls.querySelector('[name="matchKey"]');
    matchKey.disabled = !keepPitch;
    matchKey.closest('.check').style.opacity = keepPitch ? '' : '0.5';
}

controls.addEventListener('input', () => {
    refreshSettings();
    writeLocal(SETTINGS_KEY, readSettings());
    markChanged();
});
controls.querySelector('.reset').addEventListener('click', () => {
    showSettings(defaultSettings);
    writeLocal(SETTINGS_KEY, readSettings());
    markChanged();
});
showSettings({ ...defaultSettings, ...readLocal(SETTINGS_KEY, {}) });

// ---- making the mashup ----

const makeButton = document.getElementById('make');
const progress = document.querySelector('.progress');
const progressBar = progress.querySelector('.bar span');
const stageText = progress.querySelector('.stage');
const errorText = document.querySelector('.error');
const resultCard = document.querySelector('.result');
const player = resultCard.querySelector('audio');
const summary = resultCard.querySelector('.summary');
const download = resultCard.querySelector('.download');
let busy = false, made = false, changed = false, resultUrl = null;

const stages = {
    'Stretching the freestyle': [0, 0.45],
    'Shifting key': [0.45, 0.85],
    Mixing: [0.85, 1],
};

function markChanged() {
    changed = true;
    updateMake();
}

function updateMake() {
    makeButton.disabled = busy || !tracks.rtt || !tracks.song;
    makeButton.textContent = made && changed ? 'Remake with changes' : 'Make mashup';
}

function describe(plan, songInfo, settings) {
    const percent = Math.round((plan.speed - 1) * 100);
    const tempo = Math.abs(percent) < 1 ? 'kept at its own tempo' : `${percent > 0 ? 'sped up' : 'slowed down'} ${Math.abs(percent)}%`;
    let key;
    if (!settings.keepPitch) key = 'with its pitch following the speed';
    else if (plan.semitones === 0) key = 'in its original key';
    else key = `shifted ${plan.semitones > 0 ? 'up' : 'down'} ${Math.abs(plan.semitones)} semitone${Math.abs(plan.semitones) === 1 ? '' : 's'}`;
    return `Freestyle ${tempo} to match the song (${bpm(songInfo).toFixed(1)} BPM), ${key}, locked to the song's bars from ${formatTime(plan.songAnchor)}.`;
}

function fileBase(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'song';
}

makeButton.addEventListener('click', async () => {
    busy = true;
    updateMake();
    errorText.hidden = true;
    progress.hidden = false;
    progressBar.style.width = '0%';
    stageText.textContent = 'Starting…';
    const settings = readSettings();
    changed = false;
    try {
        const result = await ask({ type: 'render', settings }, [], ({ stage, fraction }) => {
            const [from, to] = stages[stage] ?? [0, 1];
            progressBar.style.width = `${Math.round((from + (to - from) * fraction) * 100)}%`;
            stageText.textContent = `${stage}…`;
        });
        if (resultUrl) URL.revokeObjectURL(resultUrl);
        resultUrl = URL.createObjectURL(new Blob([result.wav], { type: 'audio/wav' }));
        player.src = resultUrl;
        download.href = resultUrl;
        download.download = `${fileBase(tracks.song.name)} x Rin Tin Tin.wav`;
        summary.textContent = describe(result.plan, result.songInfo, settings);
        resultCard.hidden = false;
        made = true;
        resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    catch (error) {
        console.error(error);
        changed = true;
        errorText.textContent = `Something went wrong: ${error.message}`;
        errorText.hidden = false;
    }
    finally {
        busy = false;
        progress.hidden = true;
        updateMake();
    }
});

// ---- start ----

if (rememberBox.checked) {
    rememberedFreestyle().then((file) => {
        if (file && !tracks.rtt && tokens.rtt === 0) load('rtt', file);
    });
}
