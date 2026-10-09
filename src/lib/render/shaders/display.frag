#version 300 es
// Tone maps the accumulated radiance and encodes it to sRGB.
precision highp float;

uniform sampler2D uAccum;
uniform float uExposure;   // linear multiplier
uniform int uToneMapping;  // 0 ACES, 1 Reinhard, 2 linear

out vec4 fragColor;

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 reinhard(vec3 x) {
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  return x / (1.0 + l);
}

vec3 toSrgb(vec3 linear) {
  vec3 low = linear * 12.92;
  vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), linear));
}

void main() {
  vec3 hdr = max(texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb * uExposure, 0.0);
  vec3 ldr = uToneMapping == 0 ? acesFilm(hdr) : (uToneMapping == 1 ? reinhard(hdr) : clamp(hdr, 0.0, 1.0));
  vec3 srgb = toSrgb(clamp(ldr, 0.0, 1.0));
  // Half-LSB ordered dither hides banding in smooth gradients.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  fragColor = vec4(srgb + (noise - 0.5) / 255.0, 1.0);
}
