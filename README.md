# Path Tracer Web

A progressive Monte Carlo path tracer that runs entirely in the browser, written in TypeScript and GLSL on top of WebGL2.

It is a browser port of the ideas from my [C++ raytracer](https://github.com/Landry-16/Path-Tracer_Sandes_copy): the image starts noisy, then converges sample after sample while you watch. Move the pointer and the ceiling light follows it; the accumulation restarts and the scene converges again.

**Live demo:** https://landry-16.github.io/path-tracer-web/

## Features

- Unbiased Monte Carlo path tracing, one sample per pixel per frame, blended into a running average.
- Next event estimation towards a rectangular area light, cosine weighted hemisphere sampling and Russian roulette.
- Materials: Lambertian diffuse, metal with adjustable roughness, and dielectric glass with Fresnel (Schlick).
- Primitives: an open room with five walls, spheres and axis-aligned boxes.
- Thin lens depth of field, ACES tone mapping and sRGB output.
- Interactive light placed by casting a ray through the pointer onto the ceiling.
- Orbit camera with mouse, touch and keyboard controls.
- Three scene presets: a monochrome studio, a Cornell box and a metal roughness ramp.
- Export of the current frame as a PNG.

## Controls

| Input | Action |
| --- | --- |
| Move the mouse | Move the light |
| Drag | Orbit the camera |
| Scroll | Zoom |
| Double click or `0` | Reset the camera |
| Arrow keys, `+`, `-` | Orbit and zoom from the keyboard |
| `Space` | Pause or resume |
| Touch: one finger / two fingers | Move the light / orbit |

## How it works

Each frame runs two passes over a full screen triangle:

1. **Trace** (`src/shaders/trace.frag`): every pixel traces one camera path through the scene. At each diffuse hit, a shadow ray samples a random point on the area light (next event estimation), then the path continues in a cosine weighted direction. Specular bounces (metal, glass) keep emission visible so reflections and refractions of the light stay correct. The new sample is mixed into an `RGBA32F` accumulation texture with weight `1 / (n + 1)`.
2. **Display** (`src/shaders/display.frag`): the accumulated radiance is tone mapped and written to the canvas.

Two float textures are used in ping-pong, so the trace pass always reads the previous average and writes the next one. Any change to the camera, light or scene resets the sample count. Rendering stops once the image reaches 4096 samples per pixel.

## Project structure

```text
src/
  main.ts          UI wiring and render loop
  renderer.ts      Accumulation, uniforms upload and the two passes
  controls.ts      Pointer, touch and keyboard input
  camera.ts        Orbit camera
  scene.ts         Scene model and presets
  gl.ts            WebGL2 helpers (programs, float targets)
  shaders/         GLSL sources
```

## Getting started

Requires Node.js 22 and a browser with WebGL2 and `EXT_color_buffer_float` (all current desktop browsers, most recent phones).

```bash
npm install
npm run dev       # local development server
npm run build     # type check and production build in dist/
npm run preview   # serve the production build
```

Every push to `main` is built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

## License

MIT, see [LICENSE](LICENSE).
