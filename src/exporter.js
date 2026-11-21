import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { frameSize } from './params.js';

// H.264 profiles to try, highest first (level 5.2 covers 4K)
const CODECS = ['avc1.640034', 'avc1.64002A', 'avc1.640028', 'avc1.4d0034', 'avc1.42003e'];

async function pickCodec(w, h, fps, bitrate) 
{
  for (const codec of CODECS) 
    {
        const cfg = { codec, width: w, height: h, bitrate, framerate: fps };
        const r = await VideoEncoder.isConfigSupported(cfg);

        if (r.supported) return cfg;
    }
  throw new Error(`No H.264 encoder supports ${w}×${h}. Try a lower export resolution.`);
}

/**
 * Deterministic offline render: frame f is rendered at t = f / fps with exportSpp
 * sampelr per pixel, tile by tile, then fed straight to hardware encoder 
 * resolves to mp4 blob or null if cancelled
 */
export async function exportVideo(renderer, params, { onProgress, isCancelled })
{
    if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available. Use a recent desktop Chrome or Edge.');

    const { w, h } = frameSize(params.aspect, params.exportShort);
    const fps = params.fps;
    const frames = Math.max(1, Math.round(params.duration * fps));
    const cfg = await pickCodec(w, h, fps, params.bitrate * 1e6);

    const muxer = new Muxer(
    { 
        target: new ArrayBufferTarget(), 
        video: 
        { 
            codec: 'avc', 
            width: w, 
            height: h 
        }, 
        fastStart: 'in-memory' 
    });
    let encError = null;
    const encoder = new VideoEncoder(
    {
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { encError = e; },
    });
  encoder.configure(cfg);

  renderer.resize(w, h);
  const spp = Math.max(1, Math.round(params.exportSpp));
  const perPass = Math.min(spp, 4);
  const t0 = performance.now();

  for (let f = 0; f < frames; f++)
  {
    if (isCancelled())
    {
        encoder.close();
        return null;
    }
    if (encError) throw encError;
    
    const p = { ...params, time: f / fps };
    renderer.reset();

    for (let done = 0; done < spp; )
    {
        const n = Math.min(perPass, spp - done);
        await renderer.passTiled(p, n);
        done += n;
        if (isCancelled())
        {
            encoder.close();
            return null;
        }
        onProgress(`frame ${f + 1}/${frames} · ${done}/${spp} spp`);
    }

    renderer.denoise(params);
    renderer.show(params.exposure);
    
    const frame = new VideoFrame(renderer.canvas, 
        { 
            timestamp: Math.round((f * 1e6) / fps), 
            duration: Math.round(1e6 / fps) 
        });
        encoder.encode(frame, 
            {
                keyFrame: f % (fps * 2) === 0
            });
        frame.close();
        while (encoder.encodeQueueSize > 3)
        {
            await new Promise((r) => setTimeout (r, 10));
        }

        const elapsed = (performance.now() - t0) / 1000;
        const eta = (elapsed / (f + 1)) * (frames - f - 1);
        onProgress(`frame ${f + 1}/${frames} done · ETA ${Math.ceil(eta / 60)} min`);
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
