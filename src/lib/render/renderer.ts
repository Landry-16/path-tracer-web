import { DataTexture, FloatTarget, Program, createContext, createFullscreenTriangle } from "./gl";
import { LIGHT_TEXELS, MATERIAL_TEXELS, OBJECT_TEXELS, U, packScene, type PackedScene } from "./pack";
import type { Scene } from "../core/scene";
import vertexSource from "./shaders/fullscreen.vert?raw";
import traceSource from "./shaders/trace.frag?raw";
import displaySource from "./shaders/display.frag?raw";

const TONE_MAPPING_CODES = { aces: 0, reinhard: 1, linear: 2 } as const;

function sameArray(a: Float32Array | undefined, b: Float32Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Progressive WebGL2 path tracer. Each pass traces one sample per pixel into a float
 * target and blends it with the previous average (ping-pong), then the display pass
 * tone maps the result to the canvas.
 *
 * Call `sync(scene)` whenever the scene may have changed: it packs the scene, compares
 * it with what is on the GPU and restarts the accumulation only when the image would differ.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly trace: Program;
  private readonly display: Program;
  private readonly triangle: WebGLVertexArrayObject;
  private readonly objectTexture: DataTexture;
  private readonly materialTexture: DataTexture;
  private readonly lightTexture: DataTexture;
  private targets: [FloatTarget, FloatTarget] | null = null;
  private current = 0;
  private seed = 1;
  private packed: PackedScene | null = null;

  /** Samples per pixel accumulated so far. */
  samples = 0;
  /** Linear exposure multiplier used by the display pass. */
  exposure = 1;
  toneMapping: keyof typeof TONE_MAPPING_CODES = "aces";

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = createContext(canvas);
    this.trace = new Program(this.gl, vertexSource, traceSource);
    this.display = new Program(this.gl, vertexSource, displaySource);
    this.triangle = createFullscreenTriangle(this.gl);
    this.objectTexture = new DataTexture(this.gl);
    this.materialTexture = new DataTexture(this.gl);
    this.lightTexture = new DataTexture(this.gl);
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** Sets the drawing buffer size in pixels. Returns true when it changed. */
  resize(width: number, height: number): boolean {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (this.targets && width === this.canvas.width && height === this.canvas.height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.targets?.forEach((t) => t.dispose());
    this.targets = [new FloatTarget(this.gl, width, height), new FloatTarget(this.gl, width, height)];
    this.reset();
    return true;
  }

  reset(): void {
    this.samples = 0;
  }

  /** Uploads the scene if it changed. Returns true when the accumulation was restarted. */
  sync(scene: Scene): boolean {
    this.exposure = Math.pow(2, scene.render.exposure);
    this.toneMapping = scene.render.toneMapping;
    const next = packScene(scene);
    const prev = this.packed;
    let changed = false;
    if (!prev || !sameArray(prev.objects, next.objects) || prev.objectCount !== next.objectCount) {
      this.objectTexture.upload(next.objects, OBJECT_TEXELS);
      changed = true;
    }
    if (!prev || !sameArray(prev.materials, next.materials)) {
      this.materialTexture.upload(next.materials, MATERIAL_TEXELS);
      changed = true;
    }
    if (!prev || !sameArray(prev.lights, next.lights) || prev.lightCount !== next.lightCount) {
      this.lightTexture.upload(next.lights, LIGHT_TEXELS);
      changed = true;
    }
    if (!prev || !sameArray(prev.uniforms, next.uniforms)) changed = true;
    this.packed = next;
    if (changed) this.reset();
    return changed;
  }

  /** Traces `passes` more samples per pixel and presents the running average. */
  render(passes = 1): void {
    if (!this.targets || !this.packed) return;
    const gl = this.gl;
    const p = this.trace;
    const u = this.packed.uniforms;

    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.triangle);
    p.use();
    this.bindTexture(1, this.objectTexture.texture, "uObjects");
    this.bindTexture(2, this.materialTexture.texture, "uMaterials");
    this.bindTexture(3, this.lightTexture.texture, "uLights");
    gl.uniform1i(p.location("uObjectCount"), this.packed.objectCount);
    gl.uniform1i(p.location("uLightCount"), this.packed.lightCount);
    gl.uniform2f(p.location("uResolution"), this.width, this.height);
    gl.uniform3fv(p.location("uCamPos"), u.subarray(U.camPos, U.camPos + 3));
    gl.uniform3fv(p.location("uCamRight"), u.subarray(U.camRight, U.camRight + 3));
    gl.uniform3fv(p.location("uCamUp"), u.subarray(U.camUp, U.camUp + 3));
    gl.uniform3fv(p.location("uCamForward"), u.subarray(U.camForward, U.camForward + 3));
    gl.uniform1f(p.location("uTanHalfFov"), u[U.tanHalfFov]);
    gl.uniform1f(p.location("uAperture"), u[U.aperture]);
    gl.uniform1f(p.location("uFocusDistance"), u[U.focus]);
    gl.uniform1i(p.location("uEnvType"), u[U.envType]);
    gl.uniform3fv(p.location("uEnvA"), u.subarray(U.envA, U.envA + 3));
    gl.uniform3fv(p.location("uEnvB"), u.subarray(U.envB, U.envB + 3));
    gl.uniform3fv(p.location("uEnvC"), u.subarray(U.envC, U.envC + 3));
    gl.uniform1i(p.location("uMaxBounces"), u[U.maxBounces]);
    gl.uniform1f(p.location("uClamp"), u[U.clamp]);
    gl.uniform1i(p.location("uAccum"), 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < passes; i++) {
      const source = this.targets[this.current];
      const destination = this.targets[1 - this.current];
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1f(p.location("uSamples"), this.samples);
      gl.uniform1ui(p.location("uSeed"), this.seed++ >>> 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.current = 1 - this.current;
      this.samples++;
    }
    this.present();
    this.fenceFrame();
  }

  /** Re-runs only the display pass, e.g. after an exposure change. */
  present(): void {
    if (!this.targets) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.triangle);
    this.display.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current].texture);
    gl.uniform1i(this.display.location("uAccum"), 0);
    gl.uniform1f(this.display.location("uExposure"), this.exposure);
    gl.uniform1i(this.display.location("uToneMapping"), TONE_MAPPING_CODES[this.toneMapping]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private fence: WebGLSync | null = null;

  /**
   * True while the GPU is still working on the previously submitted frame.
   * Callers skip a frame instead of queueing more work, which keeps input responsive.
   */
  busy(): boolean {
    const gl = this.gl;
    if (!this.fence) return false;
    const status = gl.getSyncParameter(this.fence, gl.SYNC_STATUS);
    if (status !== gl.SIGNALED) return true;
    gl.deleteSync(this.fence);
    this.fence = null;
    return false;
  }

  /** Marks the end of the submitted work so `busy()` can tell when the GPU caught up. */
  private fenceFrame(): void {
    const gl = this.gl;
    if (this.fence) gl.deleteSync(this.fence);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  dispose(): void {
    this.targets?.forEach((t) => t.dispose());
    this.targets = null;
    this.objectTexture.dispose();
    this.materialTexture.dispose();
    this.lightTexture.dispose();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private bindTexture(unit: number, texture: WebGLTexture, uniform: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.trace.location(uniform), unit);
  }
}
