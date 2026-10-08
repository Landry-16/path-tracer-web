import { FloatTarget, Program, createContext, createFullscreenTriangle } from "./gl";
import type { OrbitCamera } from "./camera";
import { MAX_BOXES, MAX_SPHERES, type Material, type Scene } from "./scene";
import vertexSource from "./shaders/fullscreen.vert?raw";
import traceSource from "./shaders/trace.frag?raw";
import displaySource from "./shaders/display.frag?raw";

/**
 * Progressive renderer: each frame traces one sample per pixel into a float
 * target, blending it with the previous average (ping-pong), then tone maps
 * the result to the canvas. Any change to the scene or camera restarts the
 * accumulation.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly trace: Program;
  private readonly display: Program;
  private readonly triangle: WebGLVertexArrayObject;
  private targets: [FloatTarget, FloatTarget] | null = null;
  private current = 0;
  private seed = 1;

  samples = 0;
  exposure = 1;
  /** Fraction of the canvas pixel size that is actually traced. */
  resolutionScale = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    this.trace = new Program(this.gl, vertexSource, traceSource);
    this.display = new Program(this.gl, vertexSource, displaySource);
    this.triangle = createFullscreenTriangle(this.gl);
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** Matches the drawing buffer to the element size. Returns true when it changed. */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): boolean {
    const scale = pixelRatio * this.resolutionScale;
    const width = Math.max(1, Math.round(cssWidth * scale));
    const height = Math.max(1, Math.round(cssHeight * scale));
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

  /** Traces one more sample per pixel and presents the running average. */
  render(scene: Scene, camera: OrbitCamera): void {
    if (!this.targets) return;
    const gl = this.gl;
    const source = this.targets[this.current];
    const destination = this.targets[1 - this.current];

    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.triangle);

    this.trace.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(this.trace.location("uAccum"), 0);
    gl.uniform2f(this.trace.location("uResolution"), this.width, this.height);
    gl.uniform1f(this.trace.location("uSamples"), this.samples);
    gl.uniform1ui(this.trace.location("uSeed"), this.seed++);
    this.uploadCamera(camera);
    this.uploadScene(scene);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.display.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, destination.texture);
    gl.uniform1i(this.display.location("uAccum"), 0);
    gl.uniform1f(this.display.location("uExposure"), this.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.current = 1 - this.current;
    this.samples++;
  }

  private uploadCamera(camera: OrbitCamera): void {
    const gl = this.gl;
    const p = this.trace;
    const basis = camera.basis();
    gl.uniform3fv(p.location("uCamPos"), basis.position);
    gl.uniform3fv(p.location("uCamRight"), basis.right);
    gl.uniform3fv(p.location("uCamUp"), basis.up);
    gl.uniform3fv(p.location("uCamForward"), basis.forward);
    gl.uniform1f(p.location("uTanHalfFov"), Math.tan((camera.fov * Math.PI) / 360));
    gl.uniform1f(p.location("uAperture"), camera.aperture);
    gl.uniform1f(p.location("uFocusDistance"), camera.focusDistance);
  }

  private uploadScene(scene: Scene): void {
    const gl = this.gl;
    const p = this.trace;
    const { room, light } = scene;
    gl.uniform3fv(p.location("uRoomMin"), room.min);
    gl.uniform3fv(p.location("uRoomMax"), room.max);
    gl.uniform3fv(p.location("uWalls"), [...room.floor, ...room.ceiling, ...room.back, ...room.left, ...room.right]);
    gl.uniform2fv(p.location("uLightPos"), light.position);
    gl.uniform2fv(p.location("uLightHalf"), light.halfSize);
    gl.uniform3fv(p.location("uLightEmission"), light.emission);

    const spheres = scene.spheres.slice(0, MAX_SPHERES);
    gl.uniform1i(p.location("uSphereCount"), spheres.length);
    if (spheres.length > 0) {
      gl.uniform4fv(p.location("uSpheres"), spheres.flatMap((s) => [...s.center, s.radius]));
      gl.uniform4fv(p.location("uSphereMaterials"), spheres.flatMap((s) => packMaterial(s.material)));
      gl.uniform2fv(p.location("uSphereParams"), spheres.flatMap((s) => packParams(s.material)));
    }

    const boxes = scene.boxes.slice(0, MAX_BOXES);
    gl.uniform1i(p.location("uBoxCount"), boxes.length);
    if (boxes.length > 0) {
      gl.uniform3fv(p.location("uBoxMin"), boxes.flatMap((b) => b.min));
      gl.uniform3fv(p.location("uBoxMax"), boxes.flatMap((b) => b.max));
      gl.uniform4fv(p.location("uBoxMaterials"), boxes.flatMap((b) => packMaterial(b.material)));
      gl.uniform2fv(p.location("uBoxParams"), boxes.flatMap((b) => packParams(b.material)));
    }
  }
}

function packMaterial(material: Material): number[] {
  return [...material.albedo, material.type];
}

function packParams(material: Material): number[] {
  return [material.roughness ?? 0, material.ior ?? 1.5];
}
