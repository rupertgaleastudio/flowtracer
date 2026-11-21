import traceSrc from './shaders/trace.frag?raw';
import displaySrc from './shaders/display.frag?raw';
import denoiseSrc from './shaders/denoise.frag?raw';

// Fullscreen triangle, no vertex buffer needed
const VERT = `#version 300 es
void main()
{
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// '#rrggbb' (sRGB) -> linar RGB array
function hexToLinear(hex)
{
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2));
}

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

export class Renderer 
{
    constructor(canvas)
    {
        this.canvas = canvas;
        this.width = 0;
        this.height = 0;
        this.samples = 0; // samples per pixel accumulated so far
        this.tex = []; // accumulated colour, ping-pong pair
        this.guide = []; // accumulated normal + distance, ping-pong pair
        this.fbo = [];
        this.dnTex = []; // denoiser pingpong pair
        this.dnFbo = []; 
        this.outTex = null; // what show() displays

        this.cur = 0;
        this.locs = new Map();

        const gl = canvas.getContext('webgl2', 
            {
                antialias: false,
                preserveDrawingBuffer: true,
                alpha: false
            });
        if (!gl) throw new Error('WebGL2 is not available in this browser.');
        if (!gl.getExtension('EXT_color_buffer_float')) throw new Error ('EXT_color_buffer_float is required (float render targers).');
        this.gl = gl;
        this.traceProg = this.program(traceSrc, 'trace');
        this.displayProg = this.program(displaySrc, 'display');
        this.denoiseProg = this.program(denoiseSrc, 'denoise');
        gl.bindVertexArray(gl.createVertexArray());
    }

    program(frag, name)
    {
        const gl = this.gl;
        const compile = (type, src) => 
        {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error (`${name} shader:\n${gl.getShaderInfoLog(s)}`);
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link:\n${gl.getProgramInfoLog(p)}`);
        
        p.name = name;
        return p;
    }

    u(prog, name)
    {
        const key = prog.name + ':' + name;
        if (!this.locs.has(key)) this.locs.set(key, this.gl.getUniformLocation(prog, name));
        return this.locs.get(key);
    }

    // One float texture the size of the frame
    makeTexture(format, w, h)
    {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return t;
    }

    // Reallocate all render targets: accumulation (colour + guide) and denoiser, each a ping-pong pair
    resize(w, h)
    {
        if (w === this.width && h === this.height) return;
        const gl = this.gl;
        [...this.tex, ...this.guide, ...this.dnTex].forEach((t) => gl.deleteTexture(t));
        [...this.fbo, ...this.dnFbo].forEach((f) => gl.deleteFramebuffer(f));

        this.tex = [];
        this.guide = [];
        this.fbo = [];
        this.dnTex = [];
        this.dnFbo = [];

        for (let i = 0; i < 2; i++)
        {
            // accumulation: trace shader writes colour to attachment 0 and guidee to attachment 1
            const t = this.makeTexture(gl.RGBA32F, w, h);
            const g = this.makeTexture(gl.RGBA16F, w, h);
            const f = gl.createFramebuffer();

            gl.bindFramebuffer(gl.FRAMEBUFFER, f);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g, 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) 
            {
                throw new Error('Float framebuffer incomplete (out of memory at this resolution?)');
            }
            this.tex.push(t);
            this.guide.push(g);
            this.fbo.push(f);

            //Denoiser target
            const d = this.makeTexture(gl.RGBA16F, w, h);
            const df = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, df);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, d, 0);

            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            {
                throw new Error ('Denoise framebuffer incomplete');
            }
            this.dnTex.push(d);
            this.dnFbo.push(df);
        }
        this.width = this.canvas.width = w;
        this.height = this.canvas.height = h;
        this.cur = 0;
        this.samples = 0;
        this.outTex = null;
    }



    reset()
    {
        this.samples = 0;
    }

    setUniforms(p, spp)
    {
        const gl = this.gl;
        const pr = this.traceProg;
        const f1 = (n, v) => gl.uniform1f(this.u(pr, n), v);
        const i1 = (n, v) => gl.uniform1i(this.u(pr, n), v);
        const f3 = (n, v) => gl.uniform3f(this.u(pr, n), v[0], v[1], v[2]);

        // orbit camera
        const yaw = ((p.camYaw + p.orbitSpeed * p.time) * Math.PI) / 180;
        const pitch = (p.camPitch * Math.PI) / 180;

        const pos = [p.camDist * Math.cos(pitch) * Math.sin(yaw), 
        p.camDist * Math.sin(pitch), p.camDist * Math.cos(pitch) * Math.cos(yaw)];

        const len = Math.hypot(...pos);
        const fwd = pos.map((v) => -v / len);

        // right = normalize(cross(fwd, worldUp)) = (-fwd.z, 0, fwd.x); up = cross(right, fwd);

        let right = [-fwd[2], 0, fwd[0]];
        const rl = Math.hypot(...right);
        right = right.map((v) => v / rl);
        const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];

        const looping = p.loop && p.duration > 0;
        const speed = 1 / (1 + 2 * p.viscosity);

        f3('uCamPos', pos); f3('uCamFwd', fwd); f3('uCamRight', right); f3('uCamUp', up);
        f1('uFov', p.fov);
        gl.uniform2f(this.u(pr, 'uRes'), this.width, this.height);
        f1('uSampleIndex', this.samples);
        i1('uSpp', spp);
        f1('uTime', p.time);
        f1('uShutterSec', p.shutter / p.fps);
        f1('uLoop', looping ? p.duration : 0);
        f1('uSpeed', speed);
        f1('uNoiseW', looping ? (2 * Math.PI) / p.duration : 0.9 * speed);

        f1('uIOR', p.ior);
        f3('uTint', hexToLinear(p.tint));
        f1('uDensity', p.density);
        f3('uEmissive', hexToLinear(p.emissive));
        f1('uEmissiveStr', p.emissiveStrength);

        i1('uBlobs', Math.max(1, Math.min(32, Math.round(p.droplets))));
        f1('uVolume', p.volume);
        f1('uBlend', (0.12 + 0.7 * p.viscosity) * Math.sqrt(p.volume));
        f1('uSpread', p.spread);
        f1('uNoiseAmp', p.noiseAmp);
        f1('uNoiseScale', p.noiseScale);
        i1('uSeed', Math.round(p.seed));
        f1('uBound', p.spread * 1.7 + p.volume + p.noiseAmp + 0.5);

        f1('uEnvInt', p.envIntensity);
        f3('uBg', hexToLinear(p.background));
        i1('uBounces', p.bounces);
        f1('uClamp', p.clamp);
        f1('uFurnace', p.furnace ? 1 : 0);
    }

    begin(p, spp) 
    {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - this.cur]);
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.traceProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
        gl.uniform1i(this.u(this.traceProg, 'uPrev'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.guide[this.cur]);
        gl.uniform1i(this.u(this.traceProg, 'uPrevGuide'), 1);

        this.setUniforms(p, spp);
    }

    end(spp)
    {
        this.cur = 1 - this.cur;
        this.samples += spp;
    }

    // One accumulation pass over the whole frame (preview).
    pass(p, spp) 
    {
        const gl = this.gl;
        this.begin(p, spp);
        gl.disable(gl.SCISSOR_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.end(spp);
    }

    //Same pass split into tiles, yielding between them so 4K frames never trip the GPU watchdog.
    async passTiled(p, spp, tile = 384) 
    {
        const gl = this.gl;
        this.begin(p, spp);
        gl.enable(gl.SCISSOR_TEST);
        for (let y = 0; y < this.height; y += tile)
        {
          for (let x = 0; x < this.width; x += tile) 
            {
                gl.scissor(x, y, Math.min(tile, this.width - x), Math.min(tile, this.height - y));
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.finish();
                await sleep0();
            }
        }
        gl.disable(gl.SCISSOR_TEST);
        this.end(spp);
    }

    // Filter accumulated image into denoiser targets - gets called after final pass 
    denoise(p)
    {
        this.outTex = this.tex[this.cur];
        if (!p.denoise) return;

        const gl = this.gl;
        const pr = this.denoiseProg;
        gl.useProgram(pr);
        gl.viewport(0, 0, this.width, this.height);
        gl.uniform1i(this.u(pr, 'uColor'), 0);
        gl.uniform1i(this.u(pr, 'uGuide'), 1);
        gl.uniform1i(this.u(pr, 'uMoments'), 2);
        gl.uniform1f(this.u(pr, 'uSamples'), this.samples);
        gl.uniform1f(this.u(pr, 'uStrength'), p.denoiseStrength);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.guide[this.cur]);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);

        let src = this.tex[this.cur];
        for (let i = 0; i < p.denoiseIters; i++)
        {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.dnFbo[i % 2]);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src);
            gl.uniform1i(this.u(pr, 'uStep'), 1 << i); // 1, 2, 4, 8, 16 ...
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            src = this.dnTex[i % 2];
        }
        this.outTex = src;
    }


    // tonemap the accumulation buffer on to the canvas
    show(exposure)
    {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.displayProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.outTex ?? this.tex[this.cur]);
        gl.uniform1i(this.u(this.displayProg, 'uTex'), 0);
        gl.uniform1f(this.u(this.displayProg, 'uExposure'), exposure);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Debug: mean linear rgb of the buffer (white-furnace test should give ~1.0)
    meanRGB()
    {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
        
        const buf = new Float32Array(this.width * this.height * 4);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, buf);

        const s = [0, 0, 0];
        const n = this.width * this.height;
        for (let i = 0; i < n; i++)
        {
            for (let c = 0; c < 3; c++)
            {
                s[c] += buf[i * 4 + c];
            }
        }
        return s.map((v) => v / n);
    }
}
