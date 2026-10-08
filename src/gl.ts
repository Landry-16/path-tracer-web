/**
 * Thin WebGL2 helpers: context creation, shader programs and float render targets.
 */

export class GLError extends Error {}

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!gl) throw new GLError("WebGL2 is not available in this browser.");
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new GLError("This GPU cannot render to floating point textures (EXT_color_buffer_float).");
  }
  return gl;
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GLError("Could not create shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown error";
    gl.deleteShader(shader);
    throw new GLError(`Shader compilation failed:\n${log}`);
  }
  return shader;
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
    const program = gl.createProgram();
    if (!program) throw new GLError("Could not create program.");
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new GLError(`Program link failed:\n${gl.getProgramInfoLog(program) ?? "unknown error"}`);
    }
    this.handle = program;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  /** Cached uniform lookup. Returns null for uniforms the compiler optimized away. */
  location(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.handle, name));
    }
    return this.locations.get(name) ?? null;
  }
}

/** A single triangle covering the viewport, bound to attribute 0. */
export function createFullscreenTriangle(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) throw new GLError("Could not create vertex buffers.");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

/** RGBA32F texture with its framebuffer, used to accumulate radiance. */
export class FloatTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;

  constructor(private readonly gl: WebGL2RenderingContext, readonly width: number, readonly height: number) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new GLError("Could not allocate render target.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError("Float framebuffer is incomplete on this device.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.texture = texture;
    this.framebuffer = framebuffer;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}
