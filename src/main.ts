const canvas = document.querySelector<HTMLCanvasElement>("#view");
if (!canvas) throw new Error("Missing #view canvas");

const gl = canvas.getContext("webgl2");
document.title = gl ? "Path Tracer Web" : "Path Tracer Web (WebGL2 unavailable)";
