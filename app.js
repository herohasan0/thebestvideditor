import {
  Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, StreamTarget,
  CanvasSink, CanvasSource, AudioBufferSink, AudioBufferSource, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, QUALITY_HIGH, QUALITY_MEDIUM, Conversion,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from './vendor/mediabunny.min.mjs';

const $ = (id) => document.getElementById(id);
const MIN = 0.1;   // shortest allowed clip, seconds
const STILL = 5, STILL_MAX = 600; // default and longest image clip, seconds
const TILE_H = 64; // thumbnail height, matches #track in style.css

const assets = new Map(); // id -> { file, video, duration, strip, tileW, tiles }
let clips = [];           // main track: [{ id, asset, in, out }], video and images played left to right
let texts = [];           // text track: [{ id, text, in, out, at, x, y, size, color }]; x, y, size are fractions of the frame
let audio = [];           // every freely placed media clip: [{ id, asset, in, out, at }] at timeline second `at`. Sound files show on the audio track; videos and images are overlays, drawn over the main track
let selected = null, time = 0, pps = 64, playing = false, cur = null, busy = false;
let undo = [], redo = [];
let cropping = false; // crop mode: the selection box's corners cut the picture instead of resizing it
let project = null, loaded = false, pickIndex = null; // pickIndex: where picked files go on the timeline, null = library only

// Timeline switches, remembered per browser. magnet: the main track closes up by itself; snap: dragged things stick to edges, markers and the playhead; link: audio and text follow the main clip they start over.
const opt = { magnet: true, snap: true, link: true, lib: true, th: 0, side: false, guide: '', split: false }; // lib: media panel open; th: timeline height in px, 0 = the default; side: the layout with the player down the right; split: razor mode
try { Object.assign(opt, JSON.parse(localStorage.getItem('tbve-opt'))); } catch {} // storage can be blocked; the defaults still work

const keep = () => { try { localStorage.setItem('tbve-opt', JSON.stringify(opt)); } catch {} };
const uid = () => crypto.randomUUID();
const dur = (c) => c.out - c.in;
// How visible and loud a clip is `t` seconds into it: 0..1 along its fade in (fin) and fade out (fout), both in seconds.
const fade = (c, t) => Math.max(0, Math.min(1, c.fin ? t / c.fin : 1, c.fout ? (dur(c) - t) / c.fout : 1));
const gain = (c) => (c.mute || c.detached ? 0 : c.vol ?? 1); // per-clip volume, 0..1; a detached video clip's sound lives on the audio track
// A main-track clip's place inside the frame: px, py are fractions of the frame around its centre, rot is degrees.
const xf = (c) => `translate(${(c.px ?? 0) * 100}%, ${(c.py ?? 0) * 100}%) rotate(${c.rot ?? 0}deg) scale(${c.zoom ?? 1})`;
const visual = (c) => !!c?.asset && !c.snd && assets.get(c.asset).kind !== 'audio'; // a clip with a picture: main track or overlay
const picked = () => [...clips, ...audio, ...texts].find((c) => c.id === selected);
const span = (c) => (c.gap ?? 0) + dur(c); // a main-track clip plus the empty space left in front of it
const startOf = (c) => clips.slice(0, clips.indexOf(c)).reduce((s, k) => s + span(k), 0) + (c.gap ?? 0); // where a main-track clip starts
const total = () => Math.max(clips.reduce((s, c) => s + span(c), 0), ...[...audio, ...texts].map((c) => c.at + dur(c)));
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

// Main-track clip under timeline time t, or null in a gap or past the last one. A boundary belongs to the clip that starts there.
function locate(t) {
  let pos = 0;
  for (let i = 0; i < clips.length; i++) {
    const start = pos + (clips[i].gap ?? 0), end = start + dur(clips[i]);
    if (t < start) return null;
    if (t < end || (i === clips.length - 1 && t <= end + 1e-6)) return { i, clip: clips[i], start };
    pos = end;
  }
  return null;
}

// A question with one or two buttons; resolves true for the first. Used where the browser insists on a real click.
const ask = (msg, yes, no) => new Promise((done) => {
  $('ask-t').textContent = msg;
  $('ask-ok').textContent = yes; $('ask-no').textContent = no;
  $('ask').hidden = false;
  $('ask-ok').focus();
  $('ask-ok').onclick = $('ask-no').onclick = (e) => { $('ask').hidden = true; done(e.target.id === 'ask-ok'); };
});

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('show'), 3500);
}

// ---------- storage (IndexedDB: project records + the media files themselves) ----------
const db = new Promise((ok, no) => {
  const r = indexedDB.open('tbve', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('projects', { keyPath: 'id' }); r.result.createObjectStore('files'); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
const idb = async (store, method, ...args) => {
  const q = (await db).transaction(store, 'readwrite').objectStore(store)[method](...args);
  return new Promise((ok, no) => { q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
};

function save() { // debounced autosave, called from render()
  if (!loaded) return; // never write a half-loaded project back
  clearTimeout(save.t);
  save.t = setTimeout(() => {
    const cover = clips[0] ? assets.get(clips[0].asset) : [...assets.values()].find((a) => a.poster);
    Object.assign(project, { clips, audio, texts, assets: [...assets.keys()], updated: Date.now(), thumb: cover?.poster ?? project.thumb });
    idb('projects', 'put', project).catch(() => toast("Couldn't save the project in this browser"));
  }, 300);
}

async function openProject(id) {
  project = await idb('projects', 'get', id);
  if (!project) { location.hash = ''; return; }
  navigator.storage?.persist?.(); // ask the browser not to evict saved media
  $('name').value = project.name;
  const srcs = new Map(), lost = [];
  for (const a of project.assets) srcs.set(a, await idb('files', 'get', a));
  // Media opened in place is a handle to the file on disk, and the browser wants the user's OK again after a reload. That needs a click.
  const handles = [...srcs.values()].filter((s) => s?.getFile), R = { mode: 'read' };
  const locked = async () => {
    for (const h of handles) if (await h.queryPermission(R) !== 'granted' && await h.requestPermission(R).catch(() => 0) !== 'granted') return true;
    return false;
  };
  while (await locked() && await ask('Your media stays on your disk. Let this page read it again to open the project.', 'Allow access', 'Not now'));
  for (const [a, src] of srcs) {
    const file = src?.getFile ? await src.getFile().catch(() => null) : src;
    if (file) await addAsset(a, file);
    else if (src) lost.push(src.name);
  }
  // Saving would drop the clips of files we couldn't read, so that is the user's call, never a side effect.
  if (lost.length && await ask(`Can't read ${lost.join(', ')}. If you moved or renamed a file, put it back and open the project again. Opening without it removes its clips from this project.`, 'Go back', 'Open without')) { location.hash = ''; return; }
  clips = project.clips.filter((c) => assets.has(c.asset));
  audio = (project.audio ?? []).filter((c) => assets.has(c.asset));
  texts = project.texts ?? [];
  loaded = true;
  fit(); seek(0); render();
}

async function showHome() {
  document.body.classList.add('home');
  const list = (await idb('projects', 'getAll')).sort((a, b) => b.updated - a.updated);
  $('none').hidden = !!list.length;
  $('projects').replaceChildren(...list.map((p) => {
    const card = Object.assign(document.createElement('div'), { className: 'card' });
    const link = Object.assign(document.createElement('a'), { href: '#' + p.id });
    const thumb = document.createElement('i');
    if (p.thumb) thumb.style.backgroundImage = `url(${p.thumb})`;
    const when = new Date(p.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    link.append(thumb, Object.assign(document.createElement('b'), { textContent: p.name }), Object.assign(document.createElement('small'), { textContent: when }));
    const del = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Delete project', ariaLabel: `Delete ${p.name}` });
    del.onclick = async () => {
      if (!confirm(`Delete "${p.name}"? This can't be undone. Your original files are not touched.`)) return;
      const dir = await navigator.storage.getDirectory().catch(() => null);
      for (const a of p.assets) { await idb('files', 'delete', a); await idb('files', 'delete', 'proxy:' + a); dir?.removeEntry(`proxy-${a}.mp4`).catch(() => {}); }
      await idb('projects', 'delete', p.id);
      showHome();
    };
    card.append(link, del);
    return card;
  }));
}

// ---------- history ----------
const snap = () => JSON.stringify({ clips, audio, texts });
function commit() { undo.push(snap()); redo = []; }
function restore(from, to) {
  if (!from.length) return;
  pause();
  to.push(snap());
  ({ clips, audio, texts } = JSON.parse(from.pop()));
  selected = null;
  seek(time); render();
}

// ---------- import ----------
function fit() { // zoom so the whole project is in view; the 320 floor covers a timeline that has no width yet
  if (!total()) return;
  $('zoom').value = Math.log2(Math.max(0.125, Math.min(256, (Math.max(320, $('timeline').clientWidth) - 48) / total())));
  pps = 2 ** $('zoom').value;
}

const size = (el) => [el.sw ?? (el.videoWidth || el.naturalWidth), el.sh ?? (el.videoHeight || el.naturalHeight)]; // sw, sh: the source's own size, kept when the element is switched to a small preview copy
// The picture's shape: the chosen aspect ratio (short side 1080), else the first clip's, else a black 1080p frame.
function frameSize() {
  if (project?.ratio) {
    const [a, b] = project.ratio.split(':').map(Number), k = 1080 / Math.min(a, b);
    return [even(a * k), even(b * k)];
  }
  return clips[0] ? size(assets.get(clips[0].asset).el) : [1920, 1080];
}

async function addAsset(id, file) {
  let kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';
  const el = document.createElement(kind === 'image' ? 'img' : kind), url = URL.createObjectURL(file);
  el.preload = 'auto'; el.playsInline = true;
  const ok = await new Promise((r) => { el.onload = el.onloadedmetadata = () => r(true); el.onerror = () => r(false); el.src = url; });
  if (ok && kind === 'video' && !el.videoWidth) kind = 'audio'; // a video container with only sound in it
  const duration = kind === 'image' ? STILL_MAX : el.duration;
  if (!ok || !isFinite(duration)) { toast(`Can't open ${file.name}`); return false; }
  assets.set(id, { file, kind, el, url, duration });
  if (kind !== 'audio') $('view').insertBefore(el, $('texts'));
  makeStrip(id);
  if (kind === 'video') {
    [el.sw, el.sh] = [el.videoWidth, el.videoHeight];
    if (Math.min(el.sw, el.sh) > PROXY_OVER && navigator.storage?.getDirectory) { assets.get(id).busy = 0; proxies = proxies.then(() => proxy(id)).catch((err) => console.warn('No preview copy for', file.name, err)); } // busy: 0..1 while the copy is queued or being made. One at a time; the original keeps working if it fails
  }
  return true;
}

// Big videos are slow to scrub, so the player gets a small copy of them (a proxy), made once and kept in the browser's private folder.
// It is written to disk as it is made, so hours of footage never sit in memory. Export and thumbnails still read the original file.
const PROXY_OVER = 1080, PROXY_H = 540; // videos whose short side is above PROXY_OVER get a copy PROXY_H tall
let proxies = Promise.resolve();
async function proxy(id) {
  const a = assets.get(id);
  if (!a) return;
  let blob;
  const input = new Input({ source: new BlobSource(a.file), formats: ALL_FORMATS });
  try {
    const dir = await navigator.storage.getDirectory(), name = `proxy-${id}.mp4`;
    blob = await idb('files', 'get', 'proxy:' + id).catch(() => null); // true once the copy on disk is complete; older projects kept the copy itself here
    if (blob === true) blob = await dir.getFileHandle(name).then((h) => h.getFile()).catch(() => null);
    if (!blob) {
      const handle = await dir.getFileHandle(name, { create: true });
      const output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(await handle.createWritable(), { chunked: true }) });
      const job = await Conversion.init({ input, output, video: { height: PROXY_H, bitrate: QUALITY_MEDIUM, keyFrameInterval: 0.5 } }); // a key frame every half second: seeks land fast
      if (!job.isValid) throw new Error('this browser cannot convert it');
      job.onProgress = (p) => { // only the badge changes, so a long conversion doesn't redraw the editor a thousand times
        if (Math.round(p * 100) === Math.round(a.busy * 100)) return;
        a.busy = p;
        document.querySelector(`.item[data-asset="${id}"]`)?.setAttribute('data-busy', Math.round(p * 100));
      };
      await job.execute();
      blob = await handle.getFile();
      idb('files', 'put', true, 'proxy:' + id).catch(() => {}); // not marked: it is simply made again next time
    }
  } finally {
    input.dispose();
    delete a.busy; render();
  }
  a.small = blob; // the waveform reads this too: far less to decode than the original
  if (assets.get(id) !== a) return;
  a.url = URL.createObjectURL(blob);
  for (const el of [a.el, ...audio.filter((c) => c.asset === id).map((c) => players.get(c.id)).filter(Boolean)]) {
    el.addEventListener('loadeddata', sync, { once: true }); // put it back on the frame it was showing
    el.src = a.url;
  }
}

// Files always land in the library; index says where on the timeline they also go (null = nowhere).
async function addFiles(files, index = null, at = time, over = false) {
  for (const src of files) { // a handle points at the file on disk, so nothing is copied and size doesn't matter; a plain File (no handle support) is copied into the browser
    const id = uid(), file = src.getFile ? await src.getFile() : src;
    if (!await addAsset(id, file)) continue;
    idb('files', 'put', src, id).catch(() => toast(`No room to save ${file.name} in this browser. It will be missing after a reload.`));
    if (index === null) render();
    else { addClip(id, index, at, over); if (assets.get(id).kind !== 'audio') index++; }
  }
}

// Video and images join the main track at index, or float over it at time `at` when `over`; audio goes on the audio track at `at`.
function addClip(id, index = clips.length, at = time, over = false) {
  pause(); commit();
  const a = assets.get(id), c = { id: uid(), asset: id, in: 0, out: a.kind === 'image' ? STILL : a.duration };
  if (a.kind === 'audio' || over) { audio.push({ ...c, at }); if (over) selected = c.id; }
  else { const tied = anchors(); clips.splice(index, 0, c); retie(tied); }
  if (clips.length + audio.length === 1 || total() * pps > $('timeline').clientWidth - 48) fit(); // keep the new clip in view
  seek(time); render();
}

function addText() {
  pause(); commit();
  const c = { id: uid(), text: 'Your text', in: 0, out: 3, at: time, x: 0.5, y: 0.85, size: 0.08, color: '#ffffff' };
  texts.push(c);
  selected = c.id;
  if (total() * pps > $('timeline').clientWidth - 48) fit();
  render(); seek(time); // render first: the selection box measures the text's element, which render() creates
  $('text').select();
}

// One sprite of thumbnails per source file; clips tile it by time. Images are a single tile.
async function makeStrip(id) {
  const a = assets.get(id);
  if (a.kind === 'audio') return;
  let src = a.el, n = 1;
  if (a.kind === 'video') {
    src = document.createElement('video');
    src.muted = true; src.preload = 'auto'; src.src = a.url;
    await new Promise((r) => { src.onloadeddata = r; });
    n = Math.min(40, Math.max(1, Math.ceil(a.duration / 2)));
  }
  const [sw, sh] = size(src), w = Math.round(TILE_H * sw / sh);
  const cv = Object.assign(document.createElement('canvas'), { width: w * n, height: TILE_H });
  for (let i = 0; i < n; i++) {
    if (a.kind === 'video') {
      src.currentTime = (i + 0.5) * a.duration / n;
      await new Promise((r) => { src.onseeked = r; });
    }
    cv.getContext('2d').drawImage(src, i * w, 0, w, TILE_H);
    if (!i) { // library + project thumbnail
      const p = Object.assign(document.createElement('canvas'), { width: 320, height: Math.round(320 * sh / sw) });
      p.getContext('2d').drawImage(src, 0, 0, p.width, p.height);
      a.poster = p.toDataURL('image/jpeg', 0.7);
    }
  }
  cv.toBlob((blob) => {
    Object.assign(a, { strip: URL.createObjectURL(blob), tileW: w, tiles: n });
    render();
  }, 'image/jpeg', 0.7);
}

// One waveform picture per source file, made the first time it appears on the audio track.
// Decodes in a stream and keeps only the loudest sample per pixel, so long files don't fill memory.
async function makeWave(id) {
  const a = assets.get(id), input = new Input({ source: new BlobSource(a.small ?? a.file), formats: ALL_FORMATS });
  a.waving = true;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) return;
    const W = Math.min(16000, Math.ceil(a.duration * 50)), H = 64, peaks = new Float32Array(W); // 50 columns a second, capped at the canvas limit
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i += 8) { // every 8th sample is plenty for a picture
        const x = Math.floor((timestamp + i / buffer.sampleRate) / a.duration * W), v = Math.abs(d[i]);
        if (v > peaks[x]) peaks[x] = v; // out-of-range x is ignored by the typed array
      }
    }
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = cv.getContext('2d');
    ctx.fillStyle = '#b6f5e2cc';
    for (let x = 0; x < W; x++) {
      const h = Math.max(1, Math.sqrt(Math.min(1, peaks[x])) * (H - 8)); // square root lifts quiet recordings so they aren't a flat line
      ctx.fillRect(x, (H - h) / 2, 1, h);
    }
    cv.toBlob((blob) => { a.wave = URL.createObjectURL(blob); render(); });
  } catch (err) {
    console.warn('No waveform for', a.file.name, err); // the clip just stays a plain bar
  } finally {
    input.dispose();
  }
}

// ---------- preview ----------
// The playhead runs on a wall clock; media elements follow it. While a video clip is actually
// playing it becomes the clock instead, so the picture and the readout can't drift apart.
const players = new Map(); // free clip id -> its own element: an <audio> for sound, a <video> or <img> inside the frame for an overlay
let clock = 0, t0 = 0;

function follow(el, want, run) {
  if (!run) { if (Math.abs(el.currentTime - want) > 0.001) el.currentTime = want; }
  else if (el.paused) { el.currentTime = want; el.play().catch(() => {}); }
  else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
}

function sync() {
  const hit = locate(time), on = hit && assets.get(hit.clip.asset);
  for (const a of assets.values()) {
    if (a.kind === 'audio') continue;
    a.el.classList.toggle('on', a === on);
    if (a.kind === 'video' && a !== on) a.el.pause();
  }
  const f = on ? fade(hit.clip, time - hit.start) : 1;
  if (on) Object.assign(on.el.style, { transform: xf(hit.clip), clipPath: clipOf(hit.clip), opacity: f });
  if (on?.kind === 'video') { on.el.volume = gain(hit.clip) * f; follow(on.el, hit.clip.in + time - hit.start, playing); }
  for (const [id, el] of players) if (!audio.some((c) => c.id === id)) { el.pause?.(); el.remove(); players.delete(id); }
  for (const c of audio) {
    const a = assets.get(c.asset), pic = visual(c), inside = time >= c.at && time < c.at + dur(c);
    let el = players.get(c.id);
    if (!el && pic) { // overlays sit above the main picture and below the texts, later clips on top
      el = Object.assign(document.createElement(a.kind === 'image' ? 'img' : 'video'), { src: a.url, preload: 'auto', playsInline: true });
      el.dataset.id = c.id;
      $('view').insertBefore(el, $('texts'));
      players.set(c.id, el);
    }
    if (pic) { el.classList.toggle('on', inside); Object.assign(el.style, { transform: xf(c), clipPath: clipOf(c), opacity: (c.opacity ?? 1) * fade(c, time - c.at) }); }
    if (!inside || (!pic && !playing)) { el?.pause?.(); continue; }
    if (a.kind === 'image') continue;
    if (!el) players.set(c.id, el = new Audio(a.url));
    el.volume = gain(c) * fade(c, time - c.at);
    follow(el, c.in + time - c.at, playing); // a paused overlay video still shows the frame under the playhead
  }
}

function seek(t) {
  time = Math.max(0, Math.min(t, total()));
  sync(); paint();
}

function play() {
  if (!total() || busy) return;
  if (time >= total() - 0.01) seek(0);
  playing = true;
  clock = time; t0 = performance.now();
  document.body.classList.add('playing');
  tick();
}

function pause() {
  if (!playing) return;
  playing = false;
  for (const a of assets.values()) if (a.kind === 'video') a.el.pause();
  for (const el of players.values()) el.pause?.(); // an overlay image has no pause
  document.body.classList.remove('playing');
  paint(); // brings the selection box back
}

function tick() {
  if (!playing) return;
  let t = clock + (performance.now() - t0) / 1000;
  const hit = locate(time), a = hit && assets.get(hit.clip.asset);
  if (a?.kind === 'video' && !a.el.paused && !a.el.ended && !a.el.seeking) {
    const vt = hit.start + a.el.currentTime - hit.clip.in;
    if (Math.abs(vt - t) < 0.3) { t = clock = vt; t0 = performance.now(); }
  }
  if (t >= total()) { pause(); seek(total()); return; }
  time = t;
  sync(); paint();
  requestAnimationFrame(tick);
}

// ---------- edits ----------
function split() {
  const s = [...audio, ...texts].find((c) => c.id === selected);
  if (s && time - s.at >= MIN && s.at + dur(s) - time >= MIN) { // a selected audio or text clip under the playhead wins
    pause(); commit();
    const right = { ...s, id: uid(), in: s.in + time - s.at, at: time, fin: 0 }; // each half keeps only its outer fade
    (s.asset ? audio : texts).push(right);
    s.out = right.in; s.fout = 0;
    selected = right.id;
    return render();
  }
  const hit = locate(time);
  if (!hit) return;
  const at = hit.clip.in + time - hit.start;
  if (at - hit.clip.in < MIN || hit.clip.out - at < MIN) return;
  pause(); commit();
  const right = { ...hit.clip, id: uid(), in: at, gap: 0, fin: 0 };
  clips.splice(hit.i, 1, { ...hit.clip, out: at, fout: 0 }, right);
  selected = right.id;
  render();
}

// A marker is a pin on a clip, stored as a time in the clip's source so it stays on the same moment through trims, splits and moves.
function mark() {
  const s = audio.find((c) => c.id === selected && time >= c.at && time <= c.at + dur(c)); // a selected audio clip under the playhead wins, as in split()
  const hit = locate(time), c = s ?? hit?.clip;
  const at = c && c.in + time - (s ? s.at : hit.start);
  if (!c || at >= c.out) return; // the very end of a clip has no frame to pin
  const near = (c.marks ?? []).filter((m) => Math.abs(m - at) < 0.05); // M on a marker takes it off
  commit();
  c.marks = near.length ? c.marks.filter((m) => !near.includes(m)) : [...(c.marks ?? []), at]; // a new array: split halves share the old one
  render();
}
const pins = (el, c) => el.append(...(c.marks ?? []).filter((m) => m >= c.in && m < c.out)
  .map((m) => Object.assign(document.createElement('u'), { className: 'pin', title: 'Marker (M at the playhead removes it)', style: `left:${(m - c.in) * pps}px` })));

// Move a video clip's sound onto the audio track as its own clip, in the same place, so it can be edited or deleted alone.
const canDetach = (c) => clips.includes(c) && !c.detached && assets.get(c.asset).kind === 'video';
function detach() {
  const c = picked();
  if (!canDetach(c)) return;
  pause(); commit();
  const sound = { id: uid(), asset: c.asset, in: c.in, out: c.out, at: startOf(c), vol: c.vol, mute: c.mute, snd: true }; // snd: a video's sound on its own, not an overlay
  c.detached = true;
  audio.push(sound);
  selected = sound.id; // so Delete right after removes the sound
  render();
}

function remove() {
  const behind = selected?.startsWith('gap:') && clips.find((c) => 'gap:' + c.id === selected);
  if (behind) { // a selected gap: close it, pulling everything after it left
    pause(); commit();
    const tied = anchors();
    behind.gap = 0;
    retie(tied);
    selected = null;
    seek(time);
    return render();
  }
  for (const list of [clips, audio, texts]) {
    const i = list.findIndex((c) => c.id === selected);
    if (i < 0) continue;
    pause(); commit();
    const tied = anchors(), next = list === clips && clips[i + 1];
    if (next && !opt.magnet) next.gap = (next.gap ?? 0) + span(clips[i]); // magnet off: leave a hole where the clip was
    list.splice(i, 1);
    retie(tied);
    selected = null;
    seek(time); render();
  }
}

// ---------- timeline ----------
// Videos, images and texts are placed in the frame the same way; these hide the two shapes of data.
const offset = (c) => (c.asset ? [c.px ?? 0, c.py ?? 0] : [c.x - 0.5, c.y - 0.5]); // its centre, relative to the frame's centre
const moveTo = (c, dx, dy) => Object.assign(c, c.asset ? { px: dx, py: dy } : { x: dx + 0.5, y: dy + 0.5 });
const scaleOf = (c) => (c.asset ? c.zoom ?? 1 : c.size);
const setScale = (c, v) => (c.asset ? (c.zoom = Math.max(0.05, Math.min(10, v))) : (c.size = Math.max(0.01, Math.min(1, v))));
const onScreen = (c) => !!c && ('at' in c ? time >= c.at && time < c.at + dur(c) : locate(time)?.clip === c);

// Size of a clip's picture (fitted or filled, then zoomed) or of a text, before rotation, plus the frame size in the same units.
function extent(c) {
  if (!c.asset) { // a text is as big as the browser lays it out
    const el = [...$('texts').children].find((k) => k.dataset.id === c.id), f = $('frame');
    return [el.offsetWidth, el.offsetHeight, f.clientWidth, f.clientHeight];
  }
  const [fw, fh] = frameSize(), [sw, sh] = size(assets.get(c.asset).el);
  const k = Math[project.fill ? 'max' : 'min'](fw / sw, fh / sh) * (c.zoom ?? 1);
  return [sw * k, sh * k, fw, fh];
}

// Crop is stored as the fraction cut from each side of the source picture.
const cropOf = (c) => c.crop ?? { l: 0, t: 0, r: 0, b: 0 };
// The same crop as a CSS clip on the media element, which is frame-sized with the picture fitted inside it.
function clipOf(c) {
  if (!c.crop) return 'none';
  const [w, h, fw, fh] = extent({ ...c, zoom: 1 }), { l, t, r, b } = c.crop, mx = (fw - w) / 2, my = (fh - h) / 2;
  const pc = (v, of) => v / of * 100 + '%';
  return `inset(${pc(my + t * h, fh)} ${pc(mx + r * w, fw)} ${pc(my + b * h, fh)} ${pc(mx + l * w, fw)})`;
}

// Half of its outer size (its bounding box once rotated) as fractions of the frame.
// shortcut: ignores crop, so a cropped clip snaps by its uncropped edges; use the cropped box if that gets in the way
function halves(c) {
  const [w, h, fw, fh] = extent(c), r = (c.rot ?? 0) * Math.PI / 180, cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  return [(cos * w + sin * h) / 2 / fw, (sin * w + cos * h) / 2 / fh];
}

// The selection box around the selected clip or text, while it is on screen.
function drawBox() {
  const c = picked(), box = $('box');
  box.hidden = playing || !onScreen(c);
  if (box.hidden) return;
  const [w, h, fw, fh] = extent(c), [dx, dy] = offset(c), k = cropOf(c), r = (c.rot ?? 0) * Math.PI / 180;
  const sx = (k.l - k.r) / 2 * w, sy = (k.t - k.b) / 2 * h; // a lopsided crop moves the box's centre, along the picture's own axes
  box.classList.toggle('crop', cropping);
  Object.assign(box.style, {
    width: w * (1 - k.l - k.r) / fw * 100 + '%', height: h * (1 - k.t - k.b) / fh * 100 + '%',
    left: (0.5 + dx + (sx * Math.cos(r) - sy * Math.sin(r)) / fw) * 100 + '%', top: (0.5 + dy + (sx * Math.sin(r) + sy * Math.cos(r)) / fh) * 100 + '%',
    transform: `translate(-50%, -50%) rotate(${c.rot ?? 0}deg)`,
  });
}

function paint() {
  const x = time * pps, tl = $('timeline');
  $('head').style.transform = `translateX(${x}px)`;
  $('time').textContent = `${fmt(time)} / ${fmt(total())}`;
  for (const el of $('texts').children) {
    const c = texts.find((k) => k.id === el.dataset.id);
    el.hidden = !c || time < c.at || time >= c.at + dur(c);
    if (c) el.style.opacity = fade(c, time - c.at);
  }
  drawBox(); // after the texts, whose size it measures
  if (playing && (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 48)) tl.scrollLeft = x - 48;
}

function render() {
  const T = total();
  document.body.classList.toggle('empty', !clips.length && !audio.length && !texts.length);
  $('lane').style.width = T * pps + 'px';

  $('track').replaceChildren(...clips.flatMap((c) => {
    const a = assets.get(c.asset), w = dur(c) * pps;
    const gap = Object.assign(document.createElement('div'), { className: 'gap' + (selected === 'gap:' + c.id ? ' sel' : ''), title: 'Empty space' });
    gap.dataset.id = c.id;
    gap.style.width = (c.gap ?? 0) * pps + 'px';
    if ((c.gap ?? 0) * pps >= 30) { // too narrow for a button: select the gap and press Delete instead
      const close = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Close gap: pull everything after it left', ariaLabel: 'Close gap' });
      close.onclick = () => { selected = 'gap:' + c.id; remove(); }; // keyboard; the mouse is handled on pointerdown below
      gap.append(close);
    }
    const el = document.createElement('div');
    el.className = 'clip' + (c.id === selected ? ' sel' : '') + (c.mute ? ' quiet' : '');
    el.dataset.id = c.id;
    el.style.width = w + 'px';
    if (a.strip) {
      el.style.setProperty('--strip', `url(${a.strip})`);
      el.style.setProperty('--tw', a.tileW + 'px');
      for (let i = 0; i < Math.min(400, Math.ceil(w / a.tileW)); i++) {
        const at = c.in + (i + 0.5) * a.tileW / pps;
        const idx = Math.min(a.tiles - 1, Math.floor(at / a.duration * a.tiles));
        el.append(Object.assign(document.createElement('i'), { style: `background-position:${-idx * a.tileW}px 0` }));
      }
    }
    const name = document.createElement('span');
    name.textContent = a.file.name;
    el.append(name);
    pins(el, c);
    for (const side of ['l', 'r']) el.append(Object.assign(document.createElement('b'), { className: 'h ' + side }));
    return c.gap ? [gap, el] : [el];
  }));

  // Clips that overlap in time go on separate rows, so none hides another; a clip takes the first row it fits in.
  const rows = (list, track) => {
    const placed = [], row = new Map();
    for (const c of list) {
      let r = placed.findIndex((line) => line.every((k) => c.at >= k.at + dur(k) - 1e-6 || k.at >= c.at + dur(c) - 1e-6));
      if (r < 0) r = placed.push([]) - 1;
      placed[r].push(c); row.set(c, r);
    }
    track.style.setProperty('--n', Math.max(1, placed.length));
    return row;
  };
  const sounds = audio.filter((c) => !visual(c)), overs = audio.filter(visual);
  const arow = rows(sounds, $('atrack')), trow = rows(texts, $('ttrack')), orow = rows(overs, $('otrack'));
  const bar = (c, kind, label) => { // a freely placed clip on the audio or text track
    const el = Object.assign(document.createElement('div'), { className: `clip ${kind}` + (c.id === selected ? ' sel' : '') + (c.mute ? ' quiet' : '') });
    el.dataset.id = c.id;
    el.style.left = c.at * pps + 'px';
    el.style.setProperty('--r', arow.get(c) ?? trow.get(c) ?? orow.get(c));
    el.style.width = dur(c) * pps + 'px';
    const a = assets.get(c.asset); // texts have none
    if (kind === 'aud' && a.wave) Object.assign(el.style, { backgroundImage: `url(${a.wave})`, backgroundSize: `${a.duration * pps}px 100%`, backgroundPosition: `${-c.in * pps}px 0` });
    else if (kind === 'aud' && !a.waving && a.busy == null) makeWave(c.asset); // a video's sound waits for its small copy
    if (kind === 'ov' && a.poster) el.style.backgroundImage = `url(${a.poster})`;
    el.append(Object.assign(document.createElement('span'), { textContent: label }));
    if (a) pins(el, c);
    for (const side of ['l', 'r']) el.append(Object.assign(document.createElement('b'), { className: 'h ' + side }));
    return el;
  };
  $('atrack').replaceChildren(...sounds.map((c) => bar(c, 'aud', assets.get(c.asset).file.name)));
  $('otrack').replaceChildren(...overs.map((c) => bar(c, 'ov', assets.get(c.asset).file.name)));
  $('ttrack').replaceChildren(...texts.map((c) => bar(c, 'tt', c.text || '(empty)')));

  const [fw, fh] = frameSize();
  $('frame').style.setProperty('--ar', fw / fh);
  $('frame').classList.toggle('fill', !!project.fill);
  $('ratio').value = project.ratio ?? '';
  $('fill').ariaPressed = !!project.fill;
  $('texts').replaceChildren(...texts.map((c) => {
    const el = Object.assign(document.createElement('div'), { className: 'txt' + (c.id === selected ? ' sel' : ''), textContent: c.text });
    el.dataset.id = c.id;
    Object.assign(el.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', fontSize: c.size * 100 + 'cqh', color: c.color, transform: `translate(-50%, -50%) rotate(${c.rot ?? 0}deg)` });
    return el;
  }));

  const step = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600].find((s) => s * pps >= 80) ?? 3600;
  const marks = [];
  for (let t = 0; t <= T; t += step) {
    const m = document.createElement('span');
    m.style.left = t * pps + 'px';
    m.textContent = fmt(t).slice(0, step < 1 ? -1 : -3);
    marks.push(m);
  }
  $('ruler').replaceChildren(...marks);

  $('media').replaceChildren(...[...assets].map(([id, a]) => {
    const el = Object.assign(document.createElement('div'), { className: 'item ' + a.kind + (a.busy != null ? ' busy' : ''), draggable: true, tabIndex: 0, title: 'Drag to the timeline, or click to add at the end' });
    el.setAttribute('role', 'button');
    el.dataset.asset = id; el.dataset.busy = Math.round((a.busy ?? 0) * 100);
    if (a.poster) el.style.backgroundImage = `url(${a.poster})`;
    el.append(Object.assign(document.createElement('span'), { textContent: a.file.name }), Object.assign(document.createElement('small'), { textContent: a.kind === 'image' ? '' : fmt(a.duration).slice(0, -3) }));
    el.onclick = () => addClip(id);
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); addClip(id); } };
    el.ondragstart = (e) => e.dataTransfer.setData('text/asset', id);
    return el;
  }));
  $('hint').textContent = assets.size ? 'Drag media onto the timeline, or click it to add it. Audio lands at the playhead.' : 'Upload videos, images and audio, or drop them here. They stay on your computer and are never uploaded.';

  const p = picked();
  $('props').hidden = !p;
  if (p) {
    $('pname').textContent = p.asset ? assets.get(p.asset).file.name : 'Text';
    for (const k of ['fin', 'fout']) { $(k).value = p[k] ?? 0; $(k + '-s').textContent = (p[k] ?? 0).toFixed(1) + 's'; }
  }
  const sound = !!p?.asset && !p.detached && assets.get(p.asset).kind !== 'image', isText = !!p && !p.asset;
  $('mute').hidden = $('vol').hidden = !sound;
  const isPic = visual(p);
  $('scale').hidden = $('reset').hidden = $('cover').hidden = $('crop').hidden = !isPic;
  if (!isPic) cropping = false;
  $('crop').ariaPressed = cropping;
  $('opac').hidden = !(isPic && 'at' in p); // only overlays have something underneath to show through
  if (!$('opac').hidden) $('opac').value = p.opacity ?? 1;
  if (isPic) $('scale').value = p.zoom ?? 1;
  $('text').hidden = $('tsize').hidden = $('tcolor').hidden = !isText;
  if (isText) {
    if ($('text').value !== p.text) $('text').value = p.text; // don't reset the caret while typing
    $('tsize').value = p.size;
    $('tcolor').value = p.color;
  }
  if (sound) {
    $('vol').value = p.mute ? 0 : p.vol ?? 1;
    $('mute').classList.toggle('off', !!p.mute);
    $('mute').ariaPressed = !!p.mute;
  }

  $('undo').disabled = !undo.length;
  $('redo').disabled = !redo.length;
  $('del').disabled = !selected;
  $('m-delete').firstChild.textContent = selected?.startsWith('gap:') ? 'Close gap ' : 'Delete ';
  $('split').disabled = $('export').disabled = $('play').disabled = !total();
  paint();
  save();
}

// Every clip edge and marker as a timeline time, and the magnet that pulls a dragged time onto one within 8 screen pixels.
const stops = (skip, lists = [clips, audio, texts]) => lists.flat().filter((c) => c !== skip).flatMap((c) => {
  const s = 'at' in c ? c.at : startOf(c);
  return [s, s + dur(c), ...(c.marks ?? []).filter((m) => m >= c.in && m < c.out).map((m) => s + m - c.in)];
});
const stick = (t, list) => (opt.snap && list.find((s) => Math.abs(s - t) * pps < 8)) || t; // shortcut: a stop at exactly 0 is skipped by ||, harmless since times clamp to 0 anyway

// Linkage: note which main clip each audio and text clip starts over before an edit, then put them back at the same offset after it.
const anchors = () => (opt.link ? [...audio, ...texts].flatMap((k) => { const hit = locate(k.at); return hit ? [[k, hit.clip, k.at - hit.start]] : []; }) : []);
const retie = (tied) => tied.forEach(([k, c, off]) => { if (clips.includes(c)) k.at = Math.max(0, startOf(c) + off); });

// One handler for scrubbing, selecting, trimming and reordering.
$('lane').onpointerdown = (e) => {
  if (!total() || e.button) return;
  const close = e.target.closest('.gap button');
  if (close) { selected = 'gap:' + close.parentElement.dataset.id; return remove(); }
  pause();
  const blade = opt.split && e.target.closest('.clip');
  if (blade) { // razor: cut the clicked clip right there (or at the edge, marker or playhead the click sticks to)
    selected = blade.dataset.id; // split() cuts a selected audio or text clip first, else the main clip under the playhead
    seek(stick((e.clientX - $('lane').getBoundingClientRect().left) / pps, stops()));
    return split();
  }
  let x0 = e.clientX;
  const y0 = e.clientY, el = e.target.closest('.clip'), handle = e.target.closest('.h'), gap = e.target.closest('.gap');
  const c = el && [...clips, ...audio, ...texts].find((k) => k.id === el.dataset.id);
  let orig = c && { ...c }, free = c && 'at' in c; // both change if the clip is dragged to the other kind of track
  const tAt = (ev) => stick((ev.clientX - $('lane').getBoundingClientRect().left) / pps, stops());
  const s0 = c && (free ? c.at : startOf(c)), grab = c && (x0 - $('lane').getBoundingClientRect().left) / pps - s0; // how far into the clip it was grabbed
  let S = c ? [...stops(c, free ? undefined : [audio, texts]), time] : []; // what the dragged clip's edges snap to; main clips skip their own track, which moves with them
  let tied = c && !free ? anchors() : [];
  let base; // where a main clip's slide starts from; reset after each reorder
  const rebase = (x) => { const next = clips[clips.indexOf(c) + 1]; base = { x, gap: c.gap ?? 0, start: startOf(c), next, ng: next?.gap ?? 0 }; };
  if (c && !free) rebase(x0);
  let mode = handle ? 'trim' : c ? 'click' : 'scrub', saved = false;
  const save = () => { if (!saved) { commit(); saved = true; } };

  selected = c ? c.id : gap ? 'gap:' + gap.dataset.id : null;
  if (mode === 'scrub') seek(tAt(e));
  render();

  const move = (ev) => {
    let dx = ev.clientX - x0;
    if (mode === 'scrub') return seek(tAt(ev));
    if (mode === 'click') { if (Math.hypot(dx, ev.clientY - y0) < 5) return; mode = 'move'; }
    if (mode === 'move' && c.asset) { // drag a picture up off the main track to float it over the video, or back down to rejoin it
      const row = $('track').getBoundingClientRect(), raw = (ev.clientX - $('lane').getBoundingClientRect().left) / pps;
      if (!free && ev.clientY < row.top - 6) {
        save();
        const i = clips.indexOf(c), next = clips[i + 1];
        if (next && !opt.magnet) next.gap = (next.gap ?? 0) + span(c);
        clips.splice(i, 1);
        delete c.gap;
        c.at = Math.max(0, raw - grab);
        audio.push(c);
        retie(tied); tied = [];
        free = true; orig = { ...c }; x0 = ev.clientX; dx = 0; S = [...stops(c), time];
        sync();
      } else if (free && visual(c) && ev.clientY > row.top + 6 && ev.clientY < row.bottom) {
        save();
        audio.splice(audio.indexOf(c), 1);
        delete c.at;
        let start = 0, i = 0;
        for (const k of clips) { start += k.gap ?? 0; if (raw > start + dur(k) / 2) i++; start += dur(k); }
        tied = anchors();
        clips.splice(i, 0, c);
        free = false; rebase(ev.clientX);
        sync();
      }
    }
    if (mode === 'trim') {
      save();
      const left = handle.classList.contains('l');
      if (left) { // the left edge moves and everything else stays put: free clips shift their start, main-track clips leave a gap
        const pull = !free && opt.magnet; // magnet on: the clip just gets shorter and later clips close up, so there is no moving edge to snap
        const d = Math.max(-Math.min(c.asset ? orig.in : Infinity, free ? orig.at : Infinity), Math.min(dur(orig) - MIN, pull ? dx / pps : stick(s0 + dx / pps, S) - s0));
        c.in = orig.in + d;
        if (free) c.at = orig.at + d;
        else if (!pull) c.gap = Math.max(0, (orig.gap ?? 0) + d); // dragging back left eats the gap first, then pushes later clips
      } else {
        c.out = Math.min(c.asset ? assets.get(c.asset).duration : Infinity, Math.max(orig.in + MIN, orig.out + stick(s0 + dur(orig) + dx / pps, S) - s0 - dur(orig)));
        if (!free && !opt.magnet && base.next) base.next.gap = Math.max(0, base.ng - (c.out - orig.out)); // magnet off: later clips stay put until the edge reaches them
      }
      seek((free ? c.at : startOf(c)) + (left ? 0 : dur(c) - 0.02)); // show the frame being cut at
    } else if (free) {
      save();
      const at = orig.at + dx / pps, a = stick(at, S); // the start snaps first, else the end
      c.at = Math.max(0, a !== at ? a : stick(at + dur(c), S) - dur(c));
    } else { // reorder: swap once the pointer passes a neighbour's midpoint
      const t = tAt(ev), i = clips.indexOf(c), start = startOf(c), prev = clips[i - 1], next = clips[i + 1];
      const j = next && t > start + dur(c) + span(next) / 2 ? i + 1 : prev && t < start - (c.gap ?? 0) - span(prev) / 2 ? i - 1 : i; // gaps travel with their clips
      if (j !== i) { save(); clips.splice(i, 1); clips.splice(j, 0, c); rebase(ev.clientX); }
      else if (!opt.magnet) { // magnet off: slide inside the empty space around the clip
        save();
        const raw = base.start + (ev.clientX - base.x) / pps, a = stick(raw, S);
        const d = Math.max(-base.gap, Math.min(base.next ? base.ng : Infinity, (a !== raw ? a : stick(raw + dur(c), S) - dur(c)) - base.start));
        c.gap = base.gap + d;
        if (base.next) base.next.gap = base.ng - d;
      } else return;
    }
    retie(tied);
    render();
  };
  const up = (ev) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    seek(mode === 'click' ? tAt(ev) : time);
    render();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
};

// ---------- export ----------
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function outSize() { // the exported picture's size: "1080p" means the short side
  const [sw, sh] = frameSize(), pick = +$('res').value, scale = pick ? pick / Math.min(sw, sh) : 1;
  return [even(sw * scale), even(sh * scale)];
}

// A free clip cut down to the stretch [from, from + T) and moved so that stretch starts at 0; null when it lies outside.
// shortcut: a fade on an end that gets cut off is dropped, not continued mid-way; carry the fade's phase over if that shows
function cut(c, from, T) {
  const s = Math.max(c.at, from), e = Math.min(c.at + dur(c), from + T);
  return e - s < 1e-3 ? null : { ...c, in: c.in + s - c.at, out: c.in + e - c.at, at: s - from, ...(s > c.at && { fin: 0 }), ...(e < c.at + dur(c) && { fout: 0 }) };
}

// part: a main-track clip to export on its own, together with whatever sits over its stretch of the timeline (overlays, text, sound)
// Video bits per second for the chosen quality: 6 or 18 Mbit at 1080p, growing a little slower than the pixel count
// (the encoder library's own curve; its "high" preset equals the 6).
const bitrate = () => { const [w, h] = outSize(); return Math.round(+$('qual').value * 1e6 * (w * h / (1920 * 1080)) ** 0.95); };

// The clip whose source data can be copied into the export untouched (no re-encoding, so no quality loss), or null.
// That holds only for one video clip with nothing done to it but cuts, nothing over it, and a frame of its own shape.
function copyable(part) {
  const c = part ?? (clips.length === 1 && !clips[0].gap ? clips[0] : null);
  if (!c || assets.get(c.asset).kind !== 'video') return null;
  const plain = !['px', 'py', 'rot', 'crop', 'fin', 'fout', 'mute', 'detached'].some((k) => c[k]) && (c.zoom ?? 1) === 1 && (c.vol ?? 1) === 1;
  const clear = part ? ![...audio, ...texts].some((k) => cut(k, startOf(c), dur(c))) : !audio.length && !texts.length;
  return plain && clear && frameSize().join() === size(assets.get(c.asset).el).join() ? c : null;
}

async function exportVideo(part) {
  if (!total() || busy) return;
  pause();
  const from = part ? startOf(part) : 0, T = part ? dur(part) : total();
  const free = (l) => (part ? l.map((c) => cut(c, from, T)).filter(Boolean) : l.map((c) => ({ ...c })));
  const list = part ? [{ ...part, gap: 0 }] : clips.map((c) => ({ ...c }));
  const [sw, sh] = frameSize(), words = free(texts);
  const name = project.name + (part ? ` - clip ${clips.indexOf(part) + 1}` : '') + '.mp4';
  const [w, h] = outSize(), scale = w / sw;

  // every piece of sound on the timeline: the audio track plus the video clips' own audio
  const segs = free(audio.filter((c) => assets.get(c.asset).kind !== 'image'));
  const overs = free(audio.filter(visual)).map((c) => ({ ...c, it: null, cur: null })); // it, cur: an overlay video's frame stream and the frame it is on
  let pos = 0;
  for (const c of list) {
    pos += c.gap ?? 0;
    if (assets.get(c.asset).kind === 'video') segs.push({ ...c, at: pos });
    pos += dur(c);
  }

  const inputs = new Map(), sinks = new Map();
  const open = (id) => inputs.get(id) ?? inputs.set(id, new Input({ source: new BlobSource(assets.get(id).file), formats: ALL_FORMATS })).get(id);
  const format = new Mp4OutputFormat();
  const copy = $('qual').value === '0' ? copyable(part) : null; // "Original": the source's own packets go into the file as they are
  let vcodec, acodec, vt, at;
  if (copy) {
    vt = await open(copy.asset).getPrimaryVideoTrack(); at = await open(copy.asset).getPrimaryAudioTrack();
    if (!format.getSupportedVideoCodecs().includes(vt.codec) || (at && !format.getSupportedAudioCodecs().includes(at.codec))) {
      inputs.get(copy.asset).dispose();
      return toast("This file's format can't be copied into an MP4. Choose High or Maximum instead.");
    }
  } else {
    vcodec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width: w, height: h });
    acodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs());
    if (!vcodec) return toast(`This browser can't encode ${w}×${h}. Try a smaller size or Chrome.`);
  }

  let target;
  if (window.showSaveFilePicker) { // stream straight to disk, so long 4K exports don't fill RAM
    let handle;
    try { handle = await showSaveFilePicker({ suggestedName: name, types: [{ accept: { 'video/mp4': ['.mp4'] } }] }); }
    catch { return; }
    target = new StreamTarget(await handle.createWritable(), { chunked: true });
  } else {
    // shortcut: whole file is held in memory where the browser has no save picker (Firefox, Safari); upgrade to OPFS if long exports fail there
    target = new BufferTarget();
  }

  const output = new Output({ format, target });
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
  const vsrc = copy ? new EncodedVideoPacketSource(vt.codec) : new CanvasSource(canvas, { codec: vcodec, bitrate: bitrate() });
  output.addVideoTrack(vsrc, copy ? { rotation: vt.rotation } : undefined);
  const asrc = copy ? at && new EncodedAudioPacketSource(at.codec) : acodec && new AudioBufferSource({ codec: acodec, bitrate: QUALITY_HIGH });
  if (asrc) output.addAudioTrack(asrc);

  const sinkOf = async (id) => {
    if (!sinks.has(id)) {
      const track = await open(id).getPrimaryAudioTrack();
      sinks.set(id, track && await track.canDecode() ? new AudioBufferSink(track) : null);
    }
    return sinks.get(id);
  };

  let stop = false;
  busy = true;
  $('cancel').onclick = () => { stop = true; };
  $('modal').hidden = false;
  const progress = (p) => { $('prog').value = p; $('pct').textContent = `Exporting… ${Math.floor(p * 100)}%`; };
  progress(0);

  const FRAME = 1 / 30;
  const overlay = (t) => { // texts showing at timeline second t, matching .txt in style.css
    for (const c of words) {
      if (t < c.at || t >= c.at + dur(c)) continue;
      const px = c.size * h;
      Object.assign(ctx, { font: `700 ${px}px system-ui, sans-serif`, textAlign: 'center', textBaseline: 'middle', fillStyle: c.color, shadowColor: '#000a', shadowBlur: px * 0.15, shadowOffsetY: px * 0.05 });
      ctx.save();
      ctx.globalAlpha = fade(c, t - c.at);
      ctx.translate(c.x * w, c.y * h);
      ctx.rotate((c.rot ?? 0) * Math.PI / 180);
      ctx.fillText(c.text, 0, 0);
      ctx.restore();
    }
    Object.assign(ctx, { fillStyle: '#000', shadowColor: 'transparent' }); // shadows would also apply to the next frame drawn
  };
  const place = (c, t, draw, clear = true) => { // t: seconds into the clip, for its fades // clear, then draw the clip with its zoom and position around the frame centre
    if (clear) ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + (c.px ?? 0) * w, h / 2 + (c.py ?? 0) * h);
    ctx.rotate((c.rot ?? 0) * Math.PI / 180);
    ctx.scale(c.zoom ?? 1, c.zoom ?? 1);
    ctx.globalAlpha = ('at' in c ? c.opacity ?? 1 : 1) * fade(c, t);
    if (c.crop) { // the same cut as clipOf(), in export pixels
      const [pw, ph, fw] = extent({ ...c, zoom: 1 }), s = w / fw, { l, t, r, b } = c.crop;
      ctx.beginPath();
      ctx.rect((l - 0.5) * pw * s, (t - 0.5) * ph * s, (1 - l - r) * pw * s, (1 - t - b) * ph * s);
      ctx.clip();
    }
    draw();
    ctx.restore();
  };
  // A clip's picture fitted (or filled) into the export frame, plus how much bigger to decode a video so zooming in stays sharp:
  // its zoom, but never past the source's own pixels.
  const fitted = (c) => {
    const [iw, ih] = size(assets.get(c.asset).el), k = Math[project.fill ? 'max' : 'min'](w / iw, h / ih);
    return [iw * k, ih * k, Math.min(Math.max(1, c.zoom ?? 1), Math.max(1, 1 / k))];
  };
  const tops = async (t) => { // everything above the main track at timeline second t: overlays in order, then texts
    for (const c of overs) {
      if (t < c.at || t >= c.at + dur(c)) continue;
      const a = assets.get(c.asset), [dw, dh, z] = fitted(c);
      let pic = a.el;
      if (a.kind === 'video') { // frames only ever move forward, as the export does
        c.it ??= new CanvasSink(await open(c.asset).getPrimaryVideoTrack(), { width: Math.round(dw * z), height: Math.round(dh * z), fit: 'fill', poolSize: 2 }).canvases(c.in, c.out)[Symbol.asyncIterator]();
        const want = c.in + t - c.at;
        while (!c.cur || c.cur.timestamp + c.cur.duration <= want) { const n = await c.it.next(); if (n.done) break; c.cur = n.value; }
        pic = c.cur?.canvas;
      }
      if (pic) place(c, t - c.at, () => ctx.drawImage(pic, -dw / 2, -dh / 2, dw, dh), false);
    }
    overlay(t);
  };
  const still = async (start, length, draw) => { // a picture that doesn't move, as 30 fps frames players seek through cleanly
    for (let i = 0; i * FRAME < length - 1e-3 && !stop; i++) {
      draw(i * FRAME);
      await tops(start + i * FRAME);
      await vsrc.add(start + i * FRAME, Math.min(FRAME, length - i * FRAME));
      progress((start + i * FRAME) / T);
    }
  };
  const video = async () => {
    let start = 0;
    for (const c of list) {
      const a = assets.get(c.asset);
      if (c.gap) { // empty space on the main track is black
        await still(start, c.gap, () => ctx.fillRect(0, 0, w, h));
        start += c.gap;
      }
      if (a.kind === 'image') {
        const [iw, ih] = size(a.el), k = Math[project.fill ? 'max' : 'min'](w / iw, h / ih);
        await still(start, dur(c), (t) => place(c, t, () => ctx.drawImage(a.el, -iw * k / 2, -ih * k / 2, iw * k, ih * k)));
      } else {
        const [dw, dh, z] = fitted(c);
        const sink = new CanvasSink(await open(c.asset).getPrimaryVideoTrack(), { width: Math.round(dw * z), height: Math.round(dh * z), fit: 'fill', poolSize: 2 });
        for await (const f of sink.canvases(c.in, c.out)) {
          if (stop) return;
          const ts = Math.max(0, f.timestamp - c.in), end = Math.min(dur(c), f.timestamp + f.duration - c.in);
          if (end <= ts) continue;
          place(c, ts, () => ctx.drawImage(f.canvas, -dw / 2, -dh / 2, dw, dh));
          await tops(start + ts);
          await vsrc.add(start + ts, end - ts);
          progress((start + ts) / T);
        }
      }
      if (stop) return;
      start += dur(c);
    }
    await still(start, T - start, () => ctx.fillRect(0, 0, w, h)); // sound or text past the last picture plays over black
    if (!stop) vsrc.close();
  };

  const RATE = 48000, CHUNK = 10; // seconds of audio mixed at a time, keeps memory flat
  const sound = async () => {
    for (let a = 0; a < T; a += CHUNK) {
      const b = Math.min(T, a + CHUNK);
      // lengths come from timeline positions so rounding never drifts audio against video
      const frames = Math.round(b * RATE) - Math.round(a * RATE);
      if (frames <= 0) continue;
      const off = new OfflineAudioContext(2, frames, RATE); // silent wherever nothing plays
      for (const s of segs) {
        const lo = Math.max(a, s.at), hi = Math.min(b, s.at + dur(s));
        const sink = hi > lo && gain(s) && await sinkOf(s.asset);
        if (!sink) continue;
        const level = off.createGain();
        // fades are straight lines between these moments, so ramps between them are exact
        [lo, s.at + (s.fin ?? 0), s.at + dur(s) - (s.fout ?? 0), hi].filter((p) => p >= lo && p <= hi).sort((x, y) => x - y)
          .forEach((p, i) => level.gain[i ? 'linearRampToValueAtTime' : 'setValueAtTime'](gain(s) * fade(s, p - s.at), p - a));
        level.connect(off.destination);
        const from = s.in + lo - s.at, to = s.in + hi - s.at; // the same span in the source file
        for await (const { buffer, timestamp } of sink.buffers(from, to)) {
          const skip = Math.max(0, from - timestamp), len = Math.min(buffer.duration, to - timestamp) - skip;
          if (len <= 0) continue;
          const node = off.createBufferSource();
          node.buffer = buffer;
          node.connect(level);
          node.start(lo - a + Math.max(0, timestamp - from), skip, len);
        }
      }
      if (stop) return;
      await asrc.add(await off.startRendering());
    }
    asrc.close();
  };

  // Copying: a video can only start at a key frame, so the copy begins at the one at or before the cut (t0) and the sound follows it.
  let t0 = 0;
  const copyVideo = async (sink, key) => {
    let held = [], meta = { decoderConfig: await vt.getDecoderConfig() };
    for await (const p of sink.packets(key)) { // decode order, which is not always time order
      if (stop) return;
      if (p.timestamp < t0) continue; // leans on frames before the key frame, which we don't have
      if (p.timestamp >= copy.out) { if (p.type === 'key') break; held.push(p); continue; } // past the end: kept only if a frame before the end needs it
      for (const q of [...held, p]) { await vsrc.add(q.clone({ timestamp: q.timestamp - t0 }), meta); meta = undefined; }
      held = [];
      progress(Math.min(1, (p.timestamp - t0) / (copy.out - t0)));
    }
    vsrc.close();
  };
  const copySound = async () => {
    const sink = new EncodedPacketSink(at);
    let meta = { decoderConfig: await at.getDecoderConfig() };
    for await (const p of sink.packets(await sink.getPacket(t0) ?? await sink.getFirstPacket())) {
      if (stop) return;
      if (p.timestamp < t0) continue;
      if (p.timestamp >= copy.out) break;
      await asrc.add(p.clone({ timestamp: p.timestamp - t0 }), meta); meta = undefined;
    }
    asrc.close();
  };

  try {
    await output.start();
    if (copy) {
      const sink = new EncodedPacketSink(vt), key = await sink.getKeyPacket(copy.in, { verifyKeyPackets: true }) ?? await sink.getFirstPacket();
      t0 = key.timestamp;
      await Promise.all([copyVideo(sink, key), asrc ? copySound() : null]);
    } else await Promise.all([video(), asrc ? sound() : null]);
    if (stop) { await output.cancel(); toast('Export cancelled'); return; }
    await output.finalize();
    if (target instanceof BufferTarget) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
      a.download = name;
      a.click();
    }
    toast(copy ? 'Exported the original, untouched' : `Exported ${w}×${h}`);
  } catch (err) {
    stop = true;
    console.error(err);
    await output.cancel().catch(() => {});
    toast('Export failed: ' + err.message);
  } finally {
    for (const i of inputs.values()) i.dispose();
    busy = false;
    $('modal').hidden = true;
  }
}

// ---------- wiring ----------
$('new').onclick = async () => {
  const id = uid();
  await idb('projects', 'put', { id, name: 'Untitled project', updated: Date.now(), clips: [], assets: [] });
  location.hash = id;
};
$('name').oninput = (e) => { project.name = e.target.value || 'Untitled project'; save(); };
const pick = async (index) => {
  if (!window.showOpenFilePicker) { pickIndex = index; return $('file').click(); }
  try { addFiles(await showOpenFilePicker({ multiple: true, types: [{ description: 'Video, images and audio', accept: { 'video/*': [], 'image/*': [], 'audio/*': [] } }] }), index); } catch {} // closed without choosing
};
$('upload').onclick = () => pick(null);
$('drop').onclick = () => pick(clips.length);
$('file').onchange = (e) => { addFiles([...e.target.files], pickIndex); e.target.value = ''; };
$('play').onclick = () => (playing ? pause() : play());
// Click a picture or a text in the player to select it; drag to move it, snapping to the frame's centre and edges.
$('frame').onpointerdown = (e) => {
  const c = e.target.matches('.txt') ? texts.find((k) => k.id === e.target.dataset.id) : e.target.matches('video, img') ? audio.find((k) => k.id === e.target.dataset.id) ?? locate(time)?.clip : null;
  if (!c) return;
  const box = $('frame').getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, [px, py] = offset(c);
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    if (!moved) { pause(); commit(); selected = c.id; moved = true; }
    const [hx, hy] = halves(c);
    const snap = (v, half, room, guide, side) => { // centre to centre, or an edge to the frame's edge, with a guide line there
      for (const [to, line] of [[0, 50], [half - 0.5, 0], [0.5 - half, 100]]) {
        if (Math.abs(v - to) * room > 8) continue; // within 8 screen pixels
        guide.style[side] = line + '%';
        guide.classList.remove('both');
        guide.hidden = false;
        return to;
      }
      guide.hidden = true;
      return Math.max(-1, Math.min(1, v));
    };
    moveTo(c, snap(px + (ev.clientX - x0) / box.width, hx, box.width, $('gx'), 'left'), snap(py + (ev.clientY - y0) / box.height, hy, box.height, $('gy'), 'top'));
    sync(); render();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    $('gx').hidden = $('gy').hidden = true;
    if (!moved) { selected = c.id; render(); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
};
$('del').onclick = remove;
$('addtext').onclick = addText;

// Right-click a clip on the timeline for its menu.
$('lane').oncontextmenu = (e) => {
  const el = e.target.closest('.clip, .gap');
  if (!el) return;
  e.preventDefault();
  pause();
  selected = (el.matches('.gap') ? 'gap:' : '') + el.dataset.id;
  render();
  const menu = $('menu');
  $('m-detach').hidden = !canDetach(picked());
  $('m-export').hidden = !clips.includes(picked());
  menu.hidden = false;
  menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 8) + 'px';
  menu.querySelector('button:not([hidden])').focus();
};
addEventListener('pointerdown', (e) => { if (!e.target.closest?.('#menu')) $('menu').hidden = true; });
$('m-detach').onclick = () => { $('menu').hidden = true; detach(); };
$('m-delete').onclick = () => { $('menu').hidden = true; remove(); };
$('stage').onpointerdown = (e) => { if (e.target === $('stage') && selected) { selected = null; render(); } }; // click beside the frame to deselect

// Corner handles resize the selected clip or text around its centre; the round handle below rotates it.
$('box').onpointerdown = (e) => {
  const c = picked();
  if (!c) return;
  e.stopPropagation();
  const f = $('frame').getBoundingClientRect(), [dx, dy] = offset(c), cx = f.left + (0.5 + dx) * f.width, cy = f.top + (0.5 + dy) * f.height;
  const turn = e.target.matches('.rot'), scale = scaleOf(c), rot = c.rot ?? 0;
  const far = (ev) => Math.hypot(ev.clientX - cx, ev.clientY - cy), angle = (ev) => Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
  const d0 = far(e), a0 = angle(e);
  let saved = false;
  if (cropping && c.asset && !turn) { // each corner cuts its two sides; the opposite corner stays where it is
    const [w, h, fw] = extent(c), s = f.width / fw, k0 = cropOf(c), rad = -rot * Math.PI / 180;
    const west = e.target.matches('.nw, .sw'), north = e.target.matches('.nw, .ne');
    const lim = (v, other) => Math.max(0, Math.min(0.9 - other, v)); // always leave a tenth of the picture
    const move = (ev) => {
      if (!saved) commit();
      saved = true;
      const mx = ev.clientX - e.clientX, my = ev.clientY - e.clientY;
      const lx = (mx * Math.cos(rad) - my * Math.sin(rad)) / (w * s), ly = (mx * Math.sin(rad) + my * Math.cos(rad)) / (h * s); // travel along the picture's own axes, as fractions of its size
      c.crop = { ...k0, ...(west ? { l: lim(k0.l + lx, k0.r) } : { r: lim(k0.r - lx, k0.l) }), ...(north ? { t: lim(k0.t + ly, k0.b) } : { b: lim(k0.b - ly, k0.t) }) };
      sync(); render();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
    return;
  }
  const move = (ev) => {
    if (!saved) commit();
    saved = true;
    if (turn) {
      const r = rot + angle(ev) - a0, square = Math.round(r / 90) * 90;
      c.rot = Math.abs(r - square) < 3 ? square : r; // snaps to upright and quarter turns
    } else {
      // Snap to the scale at which one of its edges meets the frame's edge, and show a guide there.
      let z = scale * far(ev) / d0;
      const [hx, hy] = halves(c).map((v) => v / scaleOf(c)); // half sizes at scale 1
      const marks = [ // [scale where this edge touches, guide, side, line %, screen pixels per unit of scale]
        [(0.5 + dx) / hx, 'gx', 'left', 0, hx * f.width], [(0.5 - dx) / hx, 'gx', 'left', 100, hx * f.width],
        [(0.5 + dy) / hy, 'gy', 'top', 0, hy * f.height], [(0.5 - dy) / hy, 'gy', 'top', 100, hy * f.height],
      ];
      const near = marks.filter((m) => Math.abs(z - m[0]) * m[4] < 8).sort((a, b) => Math.abs(z - a[0]) - Math.abs(z - b[0]))[0];
      if (near) z = near[0];
      for (const id of ['gx', 'gy']) {
        const hit = marks.filter((m) => near && m[1] === id && Math.abs(m[0] - z) < 1e-6);
        $(id).hidden = !hit.length;
        $(id).classList.toggle('both', hit.length > 1); // something centred touches both sides at once
        if (hit.length) $(id).style[hit[0][2]] = (hit.length > 1 ? 0 : hit[0][3]) + '%';
      }
      setScale(c, z);
    }
    sync(); render();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    $('gx').hidden = $('gy').hidden = true;
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
};
const guide = () => { // the platform overlay is preview-only: export draws on its own canvas and never sees it
  $('plat').value = opt.guide;
  $('guide').toggleAttribute('hidden', !opt.guide);
  for (const g of $('guide').querySelectorAll('[data-p]')) g.style.display = g.dataset.p === opt.guide ? '' : 'none';
};
$('plat').onchange = (e) => { opt.guide = e.target.value; keep(); guide(); };
guide();
$('ratio').onchange = (e) => { project.ratio = e.target.value || null; render(); };
for (const k of ['magnet', 'snap', 'link', 'split']) { // split: the razor, where a click on a clip cuts it
  $(k).ariaPressed = opt[k];
  $(k).onclick = () => { $(k).ariaPressed = opt[k] = !opt[k]; keep(); };
}
// The media panel can be closed, and the timeline dragged taller by the bar above it (or with the arrow keys when focused).
const layout = () => {
  document.body.classList.toggle('nolib', !opt.lib);
  $('lib').ariaExpanded = opt.lib;
  document.body.classList.toggle('side', opt.side);
  $('side').ariaPressed = opt.side;
  if (opt.th) document.body.style.setProperty('--th', Math.max(120, Math.min(innerHeight * 0.7, opt.th)) + 'px');
  keep();
};
new ResizeObserver(() => $('pbar').style.setProperty('--fw', $('frame').offsetWidth + 'px')).observe($('frame')); // the player's controls line up with the picture's edges
$('side').onclick = () => { opt.side = !opt.side; layout(); };
$('lib').onclick = () => { opt.lib = !opt.lib; layout(); };
$('grip').onpointerdown = (e) => {
  const y0 = e.clientY, h0 = $('timeline').offsetHeight;
  const move = (ev) => { opt.th = h0 + y0 - ev.clientY; layout(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
};
$('grip').onkeydown = (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault(); e.stopPropagation(); // not the timeline's own arrow keys
  opt.th = $('timeline').offsetHeight + (e.key === 'ArrowUp' ? 24 : -24); layout();
};
layout();
$('fill').onclick = () => { project.fill = !project.fill; render(); };
$('mute').onclick = () => { const c = picked(); if (!c || $('mute').hidden) return; commit(); c.mute = !c.mute; render(); };
// Sliders and the text box change the selected clip live; one drag or typing session is one undo step.
let tweaking = false;
const tweak = (id, apply) => {
  $(id).oninput = (e) => {
    const c = picked();
    if (!c) return;
    if (!tweaking) commit();
    tweaking = true;
    apply(c, e.target.value);
    sync(); render();
  };
  $(id).onchange = () => { tweaking = false; };
};
tweak('vol', (c, v) => { c.vol = +v; c.mute = false; });
tweak('scale', (c, v) => { c.zoom = +v; });
tweak('opac', (c, v) => { c.opacity = +v; });
tweak('fin', (c, v) => { c.fin = +v; });
tweak('fout', (c, v) => { c.fout = +v; });
$('crop').onclick = () => { cropping = !cropping; render(); };
// Fill the frame with the selected clip: centred and zoomed until no empty space is left, keeping its rotation.
$('cover').onclick = () => {
  const c = picked();
  if (!visual(c)) return;
  commit();
  const [hx, hy] = halves(c); // shortcut: uses the rotated bounding box, exact at 0/90/180/270 degrees only; do the real maths if tilted clips leave corners
  setScale(c, scaleOf(c) * Math.max(0.5 / hx, 0.5 / hy));
  c.px = c.py = 0;
  sync(); render();
};
$('reset').onclick = () => {
  const c = picked();
  if (!c) return;
  commit();
  delete c.zoom; delete c.px; delete c.py; delete c.rot; delete c.crop; delete c.opacity;
  sync(); render();
};
tweak('text', (c, v) => { c.text = v; });
tweak('tsize', (c, v) => { c.size = +v; });
tweak('tcolor', (c, v) => { c.color = v; });

$('undo').onclick = () => restore(undo, redo);
$('redo').onclick = () => restore(redo, undo);
const sizeNote = () => {
  const c = copyable(part), orig = $('qual').options[2];
  orig.disabled = !c;
  if (!c && orig.selected) $('qual').value = 6;
  const copy = orig.selected && c, a = c && assets.get(c.asset);
  $('res').disabled = !!copy; // a copy is always the source's own size
  $('res-s').textContent = (copy ? size(a.el) : outSize()).join(' × ');
  $('exp-n').hidden = !copy;
  const mb = copy ? a.file.size * dur(c) / a.duration / 1e6 : bitrate() * (part ? dur(part) : total()) / 8e6; // the picture only; sound adds little
  $('qual-s').textContent = `about ${mb < 1000 ? Math.max(1, Math.round(mb)) + ' MB' : (mb / 1000).toFixed(1) + ' GB'}`;
};
let part = null; // the clip "Export clip" was chosen for; null exports the whole project
const askExport = (c) => {
  if (!total() || busy) return;
  pause();
  part = c; sizeNote();
  $('exp-t').textContent = c ? `Export clip ${clips.indexOf(c) + 1}` : 'Export video';
  $('exp').showModal(); $('go').focus();
};
$('export').onclick = () => askExport(null);
$('m-export').onclick = () => { $('menu').hidden = true; askExport(picked()); };
$('res').onchange = $('qual').onchange = sizeNote;
$('go').onclick = () => exportVideo(part); // the form closes the dialog itself; the click also carries the permission the save picker needs
$('zoom').oninput = (e) => { pps = 2 ** e.target.value; render(); };

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', () => document.body.classList.remove('dragging'));
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (!project) return;
  const inLibrary = e.target.closest?.('#library'), id = e.dataTransfer.getData('text/asset');
  let index = clips.length, t = time;
  if (e.target.closest?.('#timeline')) { // insert between clips, by midpoint; audio lands where it's dropped
    t = Math.max(0, (e.clientX - $('lane').getBoundingClientRect().left) / pps);
    let start = 0;
    index = 0;
    for (const c of clips) { start += c.gap ?? 0; if (t > start + dur(c) / 2) index++; start += dur(c); }
  }
  const over = !!e.target.closest?.('#otrack, #ttrack, #ruler'); // dropped above the main track: float over it there
  if (!id) { // handles and files must both be taken before this handler returns; the handle wins where the browser has them
    const got = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => { const f = i.getAsFile(); return i.getAsFileSystemHandle?.().then((h) => (h?.kind === 'file' ? h : f), () => f) ?? f; });
    Promise.all(got).then((files) => addFiles(files.filter(Boolean), inLibrary ? null : index, t, over));
  }
  else if (!inLibrary) addClip(id, index, t, over);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }); // tick() stops in background tabs

addEventListener('change', (e) => e.target.matches?.('select') && e.target.blur()); // a dropdown that kept focus would swallow Space and the other shortcuts
addEventListener('keydown', (e) => {
  if (busy || !project || (e.target.matches?.('select, input') && !(e.key === ' ' && e.target.type === 'range'))) return; // Space still plays from a slider
  const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
  if (key === 'escape') $('menu').hidden = true;
  if (e.target.closest?.('#menu, .gap, dialog')) return; // let Enter and Space press the focused menu item or gap button
  if (key === ' ') $('play').click();
  else if (mod && key === 'z') e.shiftKey ? restore(redo, undo) : restore(undo, redo);
  else if (mod) return;
  else if (key === 's') split();
  else if (key === 'm') e.shiftKey ? $('mute').click() : mark();
  else if (key === 'd') detach();
  else if (key === 'r' && (visual(picked()) || texts.includes(picked()))) { commit(); picked().rot = ((picked().rot ?? 0) + 90) % 360; sync(); render(); }
  else if (key === 'delete' || key === 'backspace') remove();
  else if (key === 'arrowleft' || key === 'arrowright') { pause(); seek(time + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)); }
  else return;
  e.preventDefault();
});

// shortcut: switching project or going home reloads the page instead of resetting all state; fine while load is instant
addEventListener('hashchange', () => location.reload());
const hash = location.hash.slice(1);
if (hash && hash !== 'selftest') openProject(hash);
else if (!hash) showHome();

// Self-check for the timeline maths: open index.html#selftest and read the console.
if (location.hash === '#selftest') {
  clips = [{ id: 'a', asset: 'x', in: 1, out: 3 }, { id: 'b', asset: 'x', in: 0, out: 5 }];
  console.assert(total() === 7, 'total');
  console.assert(locate(0).i === 0 && locate(1.99).i === 0, 'first clip');
  console.assert(locate(2).i === 1 && locate(2).start === 2, 'boundary belongs to next clip');
  console.assert(locate(7).i === 1 && locate(99) === null, 'exact end is the last clip, beyond it is nothing');
  audio = [{ id: 'm', asset: 'y', in: 0, out: 4, at: 5 }];
  console.assert(total() === 9, 'audio past the picture extends the project');
  const tied = anchors(); // the audio clip starts 3s into clip b
  clips.shift(); retie(tied);
  console.assert(audio[0].at === 3, 'linked audio follows its clip when an earlier one goes');
  console.assert(stick(5 + 4 / pps, stops()) === 5 && stick(4, stops()) === 4, 'snaps to a clip edge within 8px only');
  audio = [];
  clips = [];
  console.assert(locate(0) === null, 'empty');
  const k = cut({ in: 2, out: 10, at: 4, fin: 1, fout: 1 }, 6, 3); // covers 4..12 on the timeline, exported stretch is 6..9
  console.assert(k.in === 4 && k.out === 7 && k.at === 0 && k.fin === 0 && k.fout === 0, 'cut trims both ends');
  console.assert(cut({ in: 0, out: 1, at: 0 }, 6, 3) === null && cut({ in: 0, out: 2, at: 7, fin: 1 }, 6, 3).at === 1 && cut({ in: 0, out: 2, at: 7, fin: 1 }, 6, 3).fin === 1, 'cut drops outsiders, keeps insiders whole');
  console.log('selftest done');
}
