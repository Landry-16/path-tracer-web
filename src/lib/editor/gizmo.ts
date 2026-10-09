/**
 * Viewport overlay: selection outline, light glyphs and the translate / rotate / scale gizmos.
 * Drawn on a 2D canvas stacked over the path traced image; input comes from the viewer
 * through the PointerTool interface so camera controls keep working everywhere else.
 */

import { cameraBasis } from "../core/camera";
import { areaCorners, lightFrame, objectCorners, raycast } from "../core/geometry";
import {
  add,
  applyMat3,
  axisAngleMatrix,
  dot,
  eulerFromMatrix,
  madd,
  multiplyMat3,
  normalize,
  rotationMatrix,
  scale,
  sub,
  type Vec3,
} from "../core/math";
import { findItem, type Light, type Scene, type Selectable } from "../core/scene";
import type { PointerTool, Viewer } from "../viewer/viewer";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface GizmoHost {
  selectedId(): string | null;
  select(id: string | null): void;
  /** The scene was edited by a drag in progress. */
  changed(): void;
  /** The drag finished: record an undo step. */
  commit(): void;
}

type Handle =
  | { kind: "axis"; axis: 0 | 1 | 2 }
  | { kind: "center" }
  | { kind: "ring"; axis: 0 | 1 | 2 }
  | { kind: "body" };

interface DragState {
  handle: Handle;
  item: Selectable;
  startClient: [number, number];
  startPosition: Vec3;
  startRotation: Vec3;
  startScale: Vec3;
  startSize: [number, number];
  startRadius: number;
  startParam: number;
  startPoint: Vec3;
  planeNormal: Vec3;
  axisDir: Vec3;
  length: number;
  moved: boolean;
}

const AXIS_COLORS = ["#ef5b4f", "#7cc85a", "#4f93ef"];
const WORLD_AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export class Gizmo implements PointerTool {
  readonly canvas: HTMLCanvasElement;
  mode: GizmoMode = "translate";
  /** Hide the overlay entirely (e.g. for clean screenshots). */
  hidden = false;
  private drag: DragState | null = null;
  private hovered: Handle | null = null;
  private accent = "#ffb547";

  constructor(private readonly viewer: Viewer, private readonly host: GizmoHost) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pt-overlay";
    viewer.container.appendChild(this.canvas);
  }

  private get scene(): Scene {
    return this.viewer.scene;
  }

  private selection(): Selectable | null {
    return findItem(this.scene, this.host.selectedId());
  }

  /** On-screen length of the gizmo arms, in world units at the selection's depth. */
  private gizmoLength(origin: Vec3): number {
    const b = cameraBasis(this.scene.camera);
    const depth = Math.max(dot(sub(origin, b.position), b.forward), 0.05);
    return (depth * b.tanHalfFov * 2 * 70) / this.viewer.size.height;
  }

  /** Axes for the current mode: world axes for translate and rotate, local axes for scale. */
  private axes(item: Selectable): Vec3[] {
    if (this.mode !== "scale") return WORLD_AXES;
    const r = rotationMatrix(item.item.rotation);
    return WORLD_AXES.map((a) => applyMat3(r, a));
  }

  private supports(item: Selectable, handle: Handle): boolean {
    if (handle.kind === "body") return item.kind === "object" || item.item.type !== "sun";
    if (this.mode === "translate") return true;
    if (item.kind === "object") return true;
    const light = item.item as Light;
    if (this.mode === "rotate") return light.type === "area" || light.type === "sun";
    if (light.type === "area") return handle.kind === "center" || (handle.kind === "axis" && handle.axis !== 1);
    return light.type === "sphere" && handle.kind === "center";
  }

  /* -------------------------------------------------------------- picking */

  private hitHandle(clientX: number, clientY: number): Handle | null {
    const item = this.selection();
    if (!item) return null;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const origin = item.item.position;
    const o = this.viewer.project(origin);
    if (!o.visible) return null;
    const len = this.gizmoLength(origin);
    let best: { handle: Handle; d: number } | null = null;
    const consider = (handle: Handle, d: number): void => {
      if (d < 9 && this.supports(item, handle) && (!best || d < best.d)) best = { handle, d };
    };

    if (this.mode === "rotate") {
      for (const axis of [0, 1, 2] as const) {
        const pts = this.ringPoints(origin, WORLD_AXES[axis], len);
        for (let i = 0; i < pts.length - 1; i++) {
          if (!pts[i].visible || !pts[i + 1].visible) continue;
          consider({ kind: "ring", axis }, distanceToSegment(mx, my, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
        }
      }
    } else {
      const axes = this.axes(item);
      for (const axis of [0, 1, 2] as const) {
        const e = this.viewer.project(madd(origin, axes[axis], len));
        if (!e.visible) continue;
        consider({ kind: "axis", axis }, distanceToSegment(mx, my, o.x, o.y, e.x, e.y));
      }
    }
    if (Math.abs(mx - o.x) < 8 && Math.abs(my - o.y) < 8) consider({ kind: "center" }, 0);
    return best ? (best as { handle: Handle }).handle : null;
  }

  private ringPoints(origin: Vec3, axis: Vec3, radius: number): { x: number; y: number; visible: boolean }[] {
    const helper: Vec3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize([axis[1] * helper[2] - axis[2] * helper[1], axis[2] * helper[0] - axis[0] * helper[2], axis[0] * helper[1] - axis[1] * helper[0]]);
    const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    const points = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      points.push(this.viewer.project(add(origin, add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius)))));
    }
    return points;
  }

  /** Parameter along the line origin + axis * t closest to the pointer ray. */
  private axisParam(origin: Vec3, axis: Vec3, clientX: number, clientY: number): number | null {
    const ray = this.viewer.rayAt(clientX, clientY);
    const w0 = sub(origin, ray.origin);
    const b = dot(axis, ray.direction);
    const denom = 1 - b * b;
    if (denom < 1e-4) return null;
    return (b * dot(ray.direction, w0) - dot(axis, w0)) / denom;
  }

  private planePoint(point: Vec3, normal: Vec3, clientX: number, clientY: number): Vec3 | null {
    const ray = this.viewer.rayAt(clientX, clientY);
    const denom = dot(ray.direction, normal);
    if (Math.abs(denom) < 1e-5) return null;
    const t = dot(sub(point, ray.origin), normal) / denom;
    if (t <= 0) return null;
    return madd(ray.origin, ray.direction, t);
  }

  /* -------------------------------------------------------------- input */

  down(e: PointerEvent): boolean {
    if (e.button !== 0 || this.hidden) return false;
    const item = this.selection();
    if (!item) return false;
    let handle = this.hitHandle(e.clientX, e.clientY);
    let hitPoint: Vec3 | null = null;
    if (!handle) {
      // Dragging the selected item itself moves it.
      const hit = this.viewer.pick(e.clientX, e.clientY);
      if (!hit || hit.id !== item.item.id || !this.supports(item, { kind: "body" })) return false;
      handle = { kind: "body" };
      hitPoint = hit.point;
    }
    const origin = item.item.position;
    const b = cameraBasis(this.scene.camera);
    const len = this.gizmoLength(origin);
    const axes = this.axes(item);
    const light = item.kind === "light" ? (item.item as Light) : null;
    const state: DragState = {
      handle,
      item,
      startClient: [e.clientX, e.clientY],
      startPosition: [...origin],
      startRotation: [...item.item.rotation],
      startScale: item.kind === "object" ? [...item.item.scale] : [1, 1, 1],
      startSize: light ? [...light.size] : [1, 1],
      startRadius: light ? light.radius : 1,
      startParam: 0,
      startPoint: hitPoint ?? [...origin],
      planeNormal: b.forward,
      axisDir: [1, 0, 0],
      length: len,
      moved: false,
    };
    if (handle.kind === "axis") {
      state.axisDir = axes[handle.axis];
      const t = this.axisParam(origin, state.axisDir, e.clientX, e.clientY);
      if (t === null) return false;
      state.startParam = t;
    } else if (handle.kind === "center" && this.mode === "translate") {
      const p = this.planePoint(origin, b.forward, e.clientX, e.clientY);
      if (!p) return false;
      state.startPoint = p;
    } else if (handle.kind === "body") {
      state.planeNormal = e.shiftKey ? normalize([b.forward[0], 0, b.forward[2]]) : [0, 1, 0];
    }
    this.drag = state;
    this.viewer.canvas.style.cursor = "grabbing";
    return true;
  }

  move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) < 3) return;
    d.moved = true;
    const fine = e.ctrlKey || e.metaKey;
    const target = d.item.item;
    const light = d.item.kind === "light" ? (d.item.item as Light) : null;

    if (this.mode === "rotate" && d.handle.kind === "ring") {
      const o = this.viewer.project(d.startPosition);
      const rect = this.viewer.canvas.getBoundingClientRect();
      const a0 = Math.atan2(d.startClient[1] - rect.top - o.y, d.startClient[0] - rect.left - o.x);
      const a1 = Math.atan2(e.clientY - rect.top - o.y, e.clientX - rect.left - o.x);
      const axis = WORLD_AXES[d.handle.axis];
      const towardCamera = dot(axis, cameraBasis(this.scene.camera).forward) < 0;
      let angle = (a1 - a0) * (towardCamera ? -1 : 1);
      if (fine) angle = snap(angle, Math.PI / 12);
      const r = multiplyMat3(axisAngleMatrix(axis, angle), rotationMatrix(d.startRotation));
      target.rotation = eulerFromMatrix(r).map((v) => Math.round(v * 1000) / 1000) as Vec3;
    } else if (this.mode === "scale" && d.handle.kind !== "body") {
      let factor: number;
      if (d.handle.kind === "axis") {
        const t = this.axisParam(d.startPosition, d.axisDir, e.clientX, e.clientY);
        if (t === null) return;
        factor = 1 + (t - d.startParam) / d.length;
      } else {
        factor = Math.exp((e.clientX - d.startClient[0] - (e.clientY - d.startClient[1])) / 120);
      }
      factor = Math.max(0.01, factor);
      const round = (v: number): number => (fine ? Math.max(0.05, snap(v, 0.05)) : Math.max(0.001, v));
      if (d.item.kind === "object") {
        const s = [...d.startScale] as Vec3;
        if (d.handle.kind === "axis") s[d.handle.axis] = round(s[d.handle.axis] * factor);
        else for (let i = 0; i < 3; i++) s[i] = round(s[i] * factor);
        d.item.item.scale = s;
      } else if (light?.type === "area") {
        const size: [number, number] = [...d.startSize];
        if (d.handle.kind === "axis") {
          const i = d.handle.axis === 0 ? 0 : 1;
          size[i] = round(size[i] * factor);
        } else {
          size[0] = round(size[0] * factor);
          size[1] = round(size[1] * factor);
        }
        light.size = size;
      } else if (light?.type === "sphere") {
        light.radius = round(d.startRadius * factor);
      }
    } else {
      // Translation: along an axis, in the view plane, or in the ground plane for body drags.
      let delta: Vec3 | null = null;
      if (d.handle.kind === "axis") {
        const t = this.axisParam(d.startPosition, d.axisDir, e.clientX, e.clientY);
        if (t === null) return;
        delta = scale(d.axisDir, t - d.startParam);
      } else {
        const normal = d.planeNormal;
        const p = this.planePoint(d.startPoint, normal, e.clientX, e.clientY);
        if (!p) return;
        delta = sub(p, d.startPoint);
        if (d.handle.kind === "body" && normal[1] === 0) delta = [0, delta[1], 0];
      }
      let next = add(d.startPosition, delta);
      if (fine) next = next.map((v) => snap(v, 0.1)) as Vec3;
      target.position = next.map((v) => Math.round(v * 10000) / 10000) as Vec3;
    }
    this.host.changed();
  }

  up(): void {
    const d = this.drag;
    this.drag = null;
    this.viewer.canvas.style.cursor = "grab";
    if (d?.moved) this.host.commit();
  }

  hover(e: PointerEvent): boolean {
    const handle = this.hidden ? null : this.hitHandle(e.clientX, e.clientY);
    this.hovered = handle;
    this.viewer.canvas.style.cursor = handle ? "pointer" : "grab";
    return handle !== null;
  }

  leave(): void {
    this.hovered = null;
  }

  /** Selects what is under a click (or clears the selection). */
  tap(clientX: number, clientY: number): void {
    const hit = this.viewer.pick(clientX, clientY);
    this.host.select(hit ? hit.id : null);
  }

  /* -------------------------------------------------------------- drawing */

  draw(): void {
    const { width, height } = this.viewer.size;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(width * ratio);
    const ch = Math.round(height * ratio);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (this.hidden) return;
    this.accent = getComputedStyle(this.canvas).getPropertyValue("--accent").trim() || this.accent;

    const selectedId = this.host.selectedId();
    for (const light of this.scene.lights) this.drawLight(ctx, light, light.id === selectedId);

    const item = this.selection();
    if (!item) return;
    if (item.kind === "object") this.drawOutline(ctx, objectCorners(item.item));
    this.drawGizmo(ctx, item);
  }

  private line(ctx: CanvasRenderingContext2D, a: Vec3, b: Vec3): void {
    const pa = this.viewer.project(a);
    const pb = this.viewer.project(b);
    if (!pa.visible || !pb.visible) return;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }

  private drawOutline(ctx: CanvasRenderingContext2D, c: Vec3[]): void {
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.beginPath();
    for (const [a, b] of edges) this.line(ctx, c[a], c[b]);
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawLight(ctx: CanvasRenderingContext2D, light: Light, selected: boolean): void {
    const p = this.viewer.project(light.position);
    if (!p.visible) return;
    ctx.save();
    ctx.strokeStyle = selected ? this.accent : "rgba(255, 220, 160, 0.75)";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.globalAlpha = light.enabled ? 1 : 0.4;
    ctx.beginPath();
    if (light.type === "area") {
      const c = areaCorners(light);
      for (let i = 0; i < 4; i++) this.line(ctx, c[i], c[(i + 1) % 4]);
      const { normal } = lightFrame(light);
      this.line(ctx, light.position, madd(light.position, normal, this.gizmoLength(light.position) * 0.6));
    } else if (light.type === "sun") {
      const dir = applyMat3(rotationMatrix(light.rotation), [0, -1, 0]);
      this.line(ctx, light.position, madd(light.position, dir, this.gizmoLength(light.position) * 1.2));
    } else if (light.type === "sphere") {
      const edge = this.viewer.project(madd(light.position, cameraBasis(this.scene.camera).up, light.radius));
      ctx.arc(p.x, p.y, Math.max(3, Math.hypot(edge.x - p.x, edge.y - p.y)), 0, Math.PI * 2);
    }
    ctx.stroke();
    // Glyph: a small sun-like mark so every light is visible and clickable.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (light.type === "point" || light.type === "sun") {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.moveTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7);
        ctx.lineTo(p.x + Math.cos(a) * 10, p.y + Math.sin(a) * 10);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGizmo(ctx: CanvasRenderingContext2D, item: Selectable): void {
    const origin = item.item.position;
    const o = this.viewer.project(origin);
    if (!o.visible) return;
    const len = this.gizmoLength(origin);
    const active = this.drag?.handle ?? this.hovered;
    const isActive = (h: Handle): boolean =>
      !!active && active.kind === h.kind && ("axis" in active ? active.axis : -1) === ("axis" in h ? h.axis : -1);

    ctx.save();
    ctx.lineCap = "round";
    if (this.mode === "rotate") {
      for (const axis of [0, 1, 2] as const) {
        const handle: Handle = { kind: "ring", axis };
        if (!this.supports(item, handle)) continue;
        const pts = this.ringPoints(origin, WORLD_AXES[axis], len);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 || !pts[i - 1].visible ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.strokeStyle = AXIS_COLORS[axis];
        ctx.lineWidth = isActive(handle) ? 3 : 1.75;
        ctx.stroke();
      }
    } else {
      const axes = this.axes(item);
      for (const axis of [0, 1, 2] as const) {
        const handle: Handle = { kind: "axis", axis };
        if (!this.supports(item, handle)) continue;
        const e = this.viewer.project(madd(origin, axes[axis], len));
        if (!e.visible) continue;
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(e.x, e.y);
        ctx.strokeStyle = AXIS_COLORS[axis];
        ctx.fillStyle = AXIS_COLORS[axis];
        ctx.lineWidth = isActive(handle) ? 3.5 : 2;
        ctx.stroke();
        const dx = e.x - o.x, dy = e.y - o.y;
        const l = Math.hypot(dx, dy) || 1;
        const ux = dx / l, uy = dy / l;
        ctx.beginPath();
        if (this.mode === "translate") {
          ctx.moveTo(e.x + ux * 9, e.y + uy * 9);
          ctx.lineTo(e.x - uy * 4.5, e.y + ux * 4.5);
          ctx.lineTo(e.x + uy * 4.5, e.y - ux * 4.5);
          ctx.closePath();
        } else {
          ctx.rect(e.x - 4, e.y - 4, 8, 8);
        }
        ctx.fill();
      }
    }
    if (this.supports(item, { kind: "center" })) {
      ctx.beginPath();
      ctx.rect(o.x - 5, o.y - 5, 10, 10);
      ctx.fillStyle = isActive({ kind: "center" }) ? this.accent : "rgba(255, 255, 255, 0.85)";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Raycast helper for drag and drop: id of the object under a client point. */
  objectAt(clientX: number, clientY: number): string | null {
    const hit = raycast(this.scene, this.viewer.rayAt(clientX, clientY), { lights: false });
    return hit?.id ?? null;
  }
}
