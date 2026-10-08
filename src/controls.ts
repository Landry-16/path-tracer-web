import type { OrbitCamera } from "./camera";
import type { Scene, Vec3 } from "./scene";

export interface ControlsOptions {
  canvas: HTMLCanvasElement;
  camera: OrbitCamera;
  getScene: () => Scene;
  /** Called whenever the view changed and the accumulation must restart. */
  onChange: () => void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Mouse: hovering moves the ceiling light under the cursor, dragging orbits, the wheel zooms.
 * Touch: one finger moves the light, two fingers orbit.
 * Keyboard: arrows orbit, + and - zoom, 0 resets the camera.
 */
export class Controls {
  lightLocked = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragged = false;

  constructor(private readonly options: ControlsOptions) {
    const { canvas } = options;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("keydown", this.onKeyDown);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.options.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragged = false;
    if (e.pointerType === "touch" && this.pointers.size === 1) this.moveLight(e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) {
      if (e.pointerType === "mouse") this.moveLight(e);
      return;
    }
    const dx = e.clientX - previous.x;
    const dy = e.clientY - previous.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const orbiting = e.pointerType === "mouse" || this.pointers.size >= 2;
    if (orbiting) {
      if (Math.abs(dx) + Math.abs(dy) > 0) this.dragged = true;
      const speed = e.pointerType === "mouse" ? 0.005 : 0.0025;
      this.options.camera.orbit(-dx * speed, dy * speed);
      this.options.onChange();
    } else {
      this.moveLight(e);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (e.pointerType === "mouse" && !this.dragged) this.moveLight(e);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.options.camera.zoom(Math.exp(e.deltaY * 0.001));
    this.options.onChange();
  };

  private readonly onDoubleClick = (): void => {
    this.options.camera.reset();
    this.options.onChange();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const camera = this.options.camera;
    const step = 0.06;
    switch (e.key) {
      case "ArrowLeft": camera.orbit(step, 0); break;
      case "ArrowRight": camera.orbit(-step, 0); break;
      case "ArrowUp": camera.orbit(0, step); break;
      case "ArrowDown": camera.orbit(0, -step); break;
      case "+": case "=": camera.zoom(0.92); break;
      case "-": camera.zoom(1.08); break;
      case "0": camera.reset(); break;
      default: return;
    }
    e.preventDefault();
    this.options.onChange();
  };

  /** Casts a ray through the pointer and places the light where it meets the ceiling (or above the floor point). */
  private moveLight(e: PointerEvent): void {
    if (this.lightLocked) return;
    const { canvas, camera } = this.options;
    const scene = this.options.getScene();
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const basis = camera.basis();
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = rect.width / rect.height;
    const dir: Vec3 = [0, 1, 2].map(
      (i) => basis.forward[i] + basis.right[i] * nx * tanHalf * aspect + basis.up[i] * ny * tanHalf,
    ) as Vec3;

    const { min, max } = scene.room;
    const planeY = dir[1] > 0 ? max[1] : min[1];
    const t = (planeY - basis.position[1]) / (dir[1] || 1e-6);
    if (t <= 0) return;
    const half = scene.light.halfSize;
    const x = clamp(basis.position[0] + dir[0] * t, min[0] + half[0], max[0] - half[0]);
    const z = clamp(basis.position[2] + dir[2] * t, min[2] + half[1], max[2] - half[1]);
    const [px, pz] = scene.light.position;
    if (Math.abs(px - x) < 1e-3 && Math.abs(pz - z) < 1e-3) return;
    scene.light.position = [x, z];
    this.options.onChange();
  }
}
