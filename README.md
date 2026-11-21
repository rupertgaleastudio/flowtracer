# FluidTracer

Web-based generative glass/liquid simulation, exported as a 4K mp4.

I started making this to avoid paying for Houdini and it's annoying to implement in Blender.

## Run
npm install
npm run dev

Open the URL in desktop Chrome or Edge (WebCodecs H.264 is needed for export). You'll need a half decent GPU (RTX 40-series and above, M-series MacBooks should work but untested)

## Controls
- Material: IOR, tint + absorption, emissive colour + strength
- Fluid: viscosity, volume, droplet count, spread, ripple, seed
- Camera & light: yaw, pitch, distance, FOV, orbit, light, background, exposure
- Animation: time, play (Space), duration, fps, seamless loop (keep orbit at 0 when looping)
- Render quality: bounces, motion blur, aspect (16:9, 9:16, 1:1, 4:5), preview res, white furnace test
- Export: 4K / 1440p / 1080p / 720p, samples per frame, bitrate

## Export tips
- Check motion at 720p / 16 spp first, then go up to 4K / 128+ spp.
- Keep the tab open and visible while exporting.