#version 300 es
// Tone maps the accumulated radiance (ACES fit) and encodes it to sRGB.
precision highp float;

uniform sampler2D uAccum;
uniform float uExposure;

out vec4 fragColor;

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toSrgb(vec3 linear) {
  vec3 low = linear * 12.92;
  vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), linear));
}

void main() {
  vec3 hdr = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb;
  fragColor = vec4(toSrgb(acesFilm(hdr * uExposure)), 1.0);
}
