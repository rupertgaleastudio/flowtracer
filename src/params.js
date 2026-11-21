// Every user-controllable value lives here, so preset is just this object as a JSON

export const defaultParams = {
    //Material
    ior: 1.45,
    tint: '#cfeff2',
    density: 0.35,
    emissive: '#2fd3ff',
    emissiveStrength: 0.0,

    //Fluid
    viscosity: 0.35,
    volume: 1.0,
    droplets: 14,
    spread: 1.1,
    noiseAmp: 0.04,
    noiseScale: 3.0,
    seed: 7,

    //Camera
    camYaw: 20,
    camPitch: 12,
    camDist: 7.5,
    fov:32,
    orbitSpeed: 0,

    //Light
    envIntensity: 1.0,
    background: '#030405',
    exposure: 1.0,

    //Render
    bounces: 12,
    previewSpp: 1,
    maxSamples: 256,
    clamp: 24,
    shutter: 0.5, 
    furnace: false,

    //Denoiser 
    denoise: true,
    denoiseStrength: 1.5, // higher = smoother, lower = keeps more detail
    denoiseIters: 5, // passes: 5 reaches ~64 px

    //Animation
    time: 0,
    duration: 10,
    fps: 30,
    loop: true,

    //Output
    aspect: '16:9',
    previewShort: 540,
    exportShort: 2160,
    exportSpp: 64,
    bitrate: 60
};

export const ASPECTS = 
    { 
        '16:9': [16, 9], 
        '9:16': [9, 16], 
        '1:1': [1, 1],
        '4:5': [4, 5]
    };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Pixel size for an aspect + short-edge 
 * length. Always even (H.264 requires this) */

export function frameSize(aspect, short)
{
    const [a, b] = ASPECTS[aspect] ?? ASPECTS['16:9'];
    return a >= b ? 
    { w: even((short * a) / b), h: even(short) } 
    : 
    { w: even(short), h: even((short * b) / a) };
}