import { Pane } from 'tweakpane';
import { Renderer } from './renderer.js';
import { defaultParams, frameSize } from './params.js';
import { exportVideo } from './exporter.js';

const STORE = 'flowtracer.params.v1';
const canvas = document.getElementById('view');
const hud = document.getElementById('hud');

function loadSaved() 
{
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
}
const params = { ...defaultParams, ...loadSaved() };
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(params)); } catch { /* private mode */ } };

let renderer;
try 
{
  renderer = new Renderer(canvas);
} 
catch (e) 
{
  hud.textContent = String(e);
  throw e;
}

let playing = false;
let exporting = false;
let cancel = false;
let status = '';

function applyPreviewSize()
{
    const { w, h } = frameSize(params.aspect, params.previewShort);
    renderer.resize(w, h);
}
applyPreviewSize();





// UI
const pane = new Pane(
{
    container: document.getElementById('pane'),
    title: 'FlowTracer'
});

const num = (folder, key, label, min, max, step) => folder.addBinding(params, key, { label, min, max, step});


const mat = pane.addFolder({ title: 'Material' });
num(mat, 'ior', 'IOR', 1.0, 2.6, 0.001);
mat.addBinding(params, 'tint', { label: 'Tint' });
num(mat, 'density', 'Absorption', 0, 4, 0.01);
mat.addBinding(params, 'emissive', { label: 'Emissive' });
num(mat, 'emissiveStrength', 'Emission', 0, 5, 0.01);

const fluid = pane.addFolder({ title: 'Fluid' });
num(fluid, 'viscosity', 'Viscosity', 0, 1, 0.01);
num(fluid, 'volume', 'Volume', 0.4, 2.2, 0.01);
num(fluid, 'droplets', 'Droplets', 1, 32, 1);
num(fluid, 'spread', 'Spread', 0.3, 2.5, 0.01);
num(fluid, 'noiseAmp', 'Ripple', 0, 0.12, 0.001);
num(fluid, 'noiseScale', 'Ripple freq', 0.5, 8, 0.05);
num(fluid, 'seed', 'Seed', 0, 9999, 1);

fluid.addButton(
{ 
    title: 'Random seed' 
}).on('click', () => 
{ 
    params.seed = Math.floor(Math.random() * 9999); 
    pane.refresh(); onChange(); 
});
    
const cam = pane.addFolder({ title: 'Camera & light', expanded: false });
num(cam, 'camYaw', 'Yaw', -180, 180, 0.5);
num(cam, 'camPitch', 'Pitch', -60, 80, 0.5);
num(cam, 'camDist', 'Distance', 3, 20, 0.05);
num(cam, 'fov', 'FOV', 10, 90, 0.5);
num(cam, 'orbitSpeed', 'Orbit °/s', -60, 60, 0.5);
num(cam, 'envIntensity', 'Light', 0, 4, 0.01);
cam.addBinding(params, 'background', { label: 'Background' });
num(cam, 'exposure', 'Exposure', 0.1, 4, 0.01);

const anim = pane.addFolder({ title: 'Animation' });
const timeBinding = num(anim, 'time', 'Time (s)', 0, 120, 0.01);
num(anim, 'duration', 'Duration (s)', 1, 120, 0.5);
num(anim, 'fps', 'FPS', 12, 60, 1);
anim.addBinding(params, 'loop', { label: 'Seamless loop' });
const playBtn = anim.addButton({ title: '▶ Play' });
function togglePlay() 
{
    playing = !playing; 
    playBtn.title = playing ? '❚❚ Pause' : '▶ Play'; 
    renderer.reset(); 
}
playBtn.on('click', togglePlay);


const rend = pane.addFolder(
{ 
    title: 'Render quality', 
    expanded: false 
});
num(rend, 'bounces', 'Max bounces', 2, 32, 1);
num(rend, 'previewSpp', 'Preview spp/frame', 1, 8, 1);
num(rend, 'maxSamples', 'Preview max spp', 16, 4096, 16);
num(rend, 'clamp', 'Firefly clamp', 2, 200, 1);
num(rend, 'shutter', 'Motion blur', 0, 1, 0.01);
rend.addBinding(params, 'aspect', 
{ 
    label: 'Aspect', 
    options: 
    { 
        '16:9': '16:9', 
        '9:16 (vertical)': '9:16', 
        '1:1': '1:1', 
        '4:5': '4:5' 
    } 
});
rend.addBinding(params, 'previewShort', 
{
    label: 'Preview res', 
    options: 
    { 
        '360p': 360, 
        '540p': 540, 
        '720p': 720, 
        '1080p': 1080 
    } 
});
rend.addBinding(params, 'furnace', 
{ 
    label: 'White furnace test' 
});

const exp = pane.addFolder(
{ 
    title: 'Export video' 
});
exp.addBinding(params, 'exportShort', 
{ 
    label: 'Resolution', 
    options: 
    { 
        '4K (2160)': 2160, 
        '1440p': 1440, 
        '1080p': 1080, 
        '720p': 720 
    } 
});
num(exp, 'exportSpp', 'Samples / frame', 1, 1024, 1);
num(exp, 'bitrate', 'Bitrate (Mbps)', 5, 200, 1);
const exportBtn = exp.addButton({ title: '● Export MP4' });
exp.addButton(
{ 
    title: 'Cancel export' 
}).on('click', () => 
{ 
    cancel = true; 
});


const file = pane.addFolder(
{ 
    title: 'Presets & stills', 
    expanded: false 
});
file.addButton(
{ title: 'Save preset (.json)' 
}).on('click', () => download(new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' }), 'flowtracer-preset.json'));

file.addButton({ title: 'Load preset…' }).on('click', () => 
{
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json';
  inp.onchange = async () => 
    {
        const f = inp.files?.[0]; if (!f) return;
        Object.assign(params, JSON.parse(await f.text()));
        pane.refresh(); onChange();
    };
    inp.click();
});
file.addButton({ title: 'Save frame (.png)' }).on('click', () => 
{
  renderer.show(params.exposure);
  canvas.toBlob((b) => b && download(b, `flowtracer-${Date.now()}.png`), 'image/png');
});
file.addButton(
{ 
    title: 'Reset to defaults' 
}).on('click', () => 
{ 
    Object.assign(params, defaultParams); 
    pane.refresh(); 
    onChange(); 
});

function onChange() 
{
  if (exporting) return;
  applyPreviewSize();
  renderer.reset();
  save();
}
pane.on('change', onChange);

exportBtn.on('click', async () => 
{
    if (exporting) return;
    exporting = true; cancel = false; playing = false; playBtn.title = '▶ Play';
    const snapshot = { ...params };
    try
    {
        const blob = await exportVideo(renderer, snapshot, 
        {
            onProgress: (m) => { status = `EXPORT ${m}`; },
            isCancelled: () => cancel,
        });
    if (blob) download(blob, `flowtracer-${Date.now()}.mp4`);
    status = blob ? 'Export finished.' : 'Export cancelled.';
    } catch (e) 
    {
        status = `Export failed: ${e.message ?? e}`;
        console.error(e);
    } finally 
    {
        exporting = false;
        applyPreviewSize();
        renderer.reset();
    }
});

function download(blob, name) 
{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

window.addEventListener('keydown', (e) => 
{
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') 
    { 
        e.preventDefault(); togglePlay(); 
    }
});




// LOOP
let last = performance.now();
function frame(now)
{
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (exporting)
    {
        hud.textContent = status;
        return;
    }
    if (playing)
    {
        params.time += dt;
        if (params.time > params.duration)
        {
            params.time = 0;
        }
        timeBinding.refresh();
        renderer.reset();
    }
    if (playing || renderer.samples < params.maxSamples)
    {
        renderer.pass(params, params.previewSpp);
    }
    renderer.show(params.exposure);
    hud.textContent = `${renderer.width}×${renderer.height} · ${renderer.samples} spp · t=${params.time.toFixed(2)}s${status ? ' · ' + status : ''}`;
}
requestAnimationFrame(frame);

// Useful for console experiments e.g. flowtracer.params.ior = 2;
flowtracer.onChange()
window.flowtracer = { renderer, params, onChange };
