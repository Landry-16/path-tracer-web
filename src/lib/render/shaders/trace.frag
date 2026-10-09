#version 300 es
// Unidirectional path tracer: one sample per pixel per pass, blended into a running average.
// Materials follow a metallic-roughness model (Lambert + GGX specular + clearcoat + rough
// dielectric transmission). Direct light uses next event estimation combined with BSDF
// sampling through multiple importance sampling (power heuristic).
precision highp float;
precision highp int;
precision highp sampler2D;

#define PI 3.14159265359
#define TWO_PI 6.28318530718
#define INV_PI 0.31830988618
#define INF 1e20
#define MAX_BOUNCES_LIMIT 32

#define SHAPE_SPHERE 0
#define SHAPE_BOX 1
#define SHAPE_CYLINDER 2
#define SHAPE_CONE 3
#define SHAPE_PLANE 4
#define SHAPE_DISK 5

#define LIGHT_AREA 0
#define LIGHT_SPHERE 1
#define LIGHT_POINT 2
#define LIGHT_SUN 3

uniform sampler2D uAccum;
uniform sampler2D uObjects;
uniform sampler2D uMaterials;
uniform sampler2D uLights;
uniform int uObjectCount;
uniform int uLightCount;

uniform vec2 uResolution;
uniform float uSamples;
uniform uint uSeed;
uniform int uMaxBounces;
uniform float uClamp;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;
uniform float uAperture;
uniform float uFocusDistance;

uniform int uEnvType;
uniform vec3 uEnvA; // color, or zenith
uniform vec3 uEnvB; // horizon
uniform vec3 uEnvC; // ground

out vec4 fragColor;

// ---------------------------------------------------------------- random

uint rngState;

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float rand() {
  rngState = pcgHash(rngState);
  return float(rngState) * (1.0 / 4294967296.0);
}

vec2 rand2() {
  return vec2(rand(), rand());
}

// ---------------------------------------------------------------- helpers

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float k = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * k, -s * n.x);
  b = vec3(k, s + n.y * n.y * a, -n.y);
}

vec3 toWorld(vec3 v, vec3 n) {
  vec3 t, b;
  basis(n, t, b);
  return t * v.x + b * v.y + n * v.z;
}

vec3 toLocal(vec3 v, vec3 n) {
  vec3 t, b;
  basis(n, t, b);
  return vec3(dot(v, t), dot(v, b), dot(v, n));
}

vec2 sampleDisk(vec2 u) {
  float r = sqrt(u.x);
  float a = TWO_PI * u.y;
  return r * vec2(cos(a), sin(a));
}

vec3 sampleCosine(vec3 n) {
  vec2 d = sampleDisk(rand2());
  return toWorld(vec3(d, sqrt(max(0.0, 1.0 - dot(d, d)))), n);
}

/** Uniform direction inside a cone around `axis`, given 1 - cos(max angle). */
vec3 sampleCone(vec3 axis, float oneMinusCosMax) {
  vec2 u = rand2();
  float cosT = 1.0 - u.x * oneMinusCosMax;
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  float phi = TWO_PI * u.y;
  return toWorld(vec3(cos(phi) * sinT, sin(phi) * sinT, cosT), axis);
}

float powerHeuristic(float a, float b) {
  float a2 = a * a;
  float b2 = b * b;
  return a2 + b2 > 0.0 ? a2 / (a2 + b2) : 0.0;
}

// ---------------------------------------------------------------- scene data

vec4 objectTexel(int i, int k) { return texelFetch(uObjects, ivec2(k, i), 0); }
vec4 materialTexel(int i, int k) { return texelFetch(uMaterials, ivec2(k, i), 0); }
vec4 lightTexel(int i, int k) { return texelFetch(uLights, ivec2(k, i), 0); }

struct Material {
  vec3 base;
  float metallic;
  vec3 emission;
  float roughness;
  float specular;
  float transmission;
  float ior;
  float clearcoat;
  float clearcoatRoughness;
};

Material loadMaterial(int index, vec3 localP) {
  vec4 t0 = materialTexel(index, 0);
  vec4 t1 = materialTexel(index, 1);
  vec4 t2 = materialTexel(index, 2);
  vec4 t3 = materialTexel(index, 3);
  vec4 t4 = materialTexel(index, 4);
  Material m;
  m.base = t0.rgb;
  m.metallic = t0.a;
  m.emission = t1.rgb;
  m.roughness = t1.a;
  m.specular = t2.x;
  m.transmission = t2.y;
  m.ior = max(t2.z, 1.0001);
  m.clearcoat = t2.w;
  m.clearcoatRoughness = t4.x;
  if (t4.y > 0.5) {
    vec3 cell = floor(localP * t3.a + 1e-3);
    float checker = mod(cell.x + cell.y + cell.z, 2.0);
    m.base = mix(m.base, t3.rgb, checker);
  }
  return m;
}

// ---------------------------------------------------------------- intersection

struct Hit {
  float t;
  vec3 normal;   // world space, outward
  vec3 localP;   // object space hit point in world units (patterns)
  int material;  // -1 when not an object
  int light;     // -1 when not a light
};

/** Updates t and the local normal when the root is closer. */
void considerRoot(float t, vec3 n, float tMin, inout float best, inout vec3 bestN) {
  if (t > tMin && t < best) {
    best = t;
    bestN = n;
  }
}

/** Unit shapes inside [-0.5, 0.5]^3. d is not normalized, so t is the world distance. */
bool intersectShape(int shape, vec3 o, vec3 d, float tMax, out float tHit, out vec3 nLocal) {
  const float tMin = 1e-5;
  float best = tMax;
  vec3 bestN = vec3(0.0);

  if (shape == SHAPE_SPHERE) {
    float a = dot(d, d);
    float b = dot(o, d);
    float c = dot(o, o) - 0.25;
    float disc = b * b - a * c;
    if (disc < 0.0) return false;
    float s = sqrt(disc);
    float t0 = (-b - s) / a;
    float t1 = (-b + s) / a;
    considerRoot(t0, (o + d * t0) * 2.0, tMin, best, bestN);
    if (best == tMax) considerRoot(t1, (o + d * t1) * 2.0, tMin, best, bestN);
  } else if (shape == SHAPE_BOX) {
    vec3 inv = 1.0 / d;
    vec3 ta = (vec3(-0.5) - o) * inv;
    vec3 tb = (vec3(0.5) - o) * inv;
    vec3 tmin3 = min(ta, tb);
    vec3 tmax3 = max(ta, tb);
    float tNear = max(max(tmin3.x, tmin3.y), tmin3.z);
    float tFar = min(min(tmax3.x, tmax3.y), tmax3.z);
    if (tNear > tFar) return false;
    float t = tNear > tMin ? tNear : tFar;
    if (t > tMin && t < best) {
      vec3 p = o + d * t;
      vec3 ap = abs(p);
      vec3 n = ap.x > ap.y && ap.x > ap.z ? vec3(sign(p.x), 0.0, 0.0) : (ap.y > ap.z ? vec3(0.0, sign(p.y), 0.0) : vec3(0.0, 0.0, sign(p.z)));
      best = t;
      bestN = n;
    }
  } else if (shape == SHAPE_CYLINDER) {
    float a = d.x * d.x + d.z * d.z;
    float b = o.x * d.x + o.z * d.z;
    float c = o.x * o.x + o.z * o.z - 0.25;
    float disc = b * b - a * c;
    if (a > 1e-12 && disc >= 0.0) {
      float s = sqrt(disc);
      for (int k = 0; k < 2; k++) {
        float t = (-b + (k == 0 ? -s : s)) / a;
        vec3 p = o + d * t;
        if (abs(p.y) <= 0.5) considerRoot(t, vec3(p.x, 0.0, p.z), tMin, best, bestN);
      }
    }
    if (abs(d.y) > 1e-12) {
      for (int k = 0; k < 2; k++) {
        float y = k == 0 ? -0.5 : 0.5;
        float t = (y - o.y) / d.y;
        vec3 p = o + d * t;
        if (p.x * p.x + p.z * p.z <= 0.25) considerRoot(t, vec3(0.0, y, 0.0), tMin, best, bestN);
      }
    }
  } else if (shape == SHAPE_CONE) {
    float s0 = 0.5 - o.y;
    float a = d.x * d.x + d.z * d.z - d.y * d.y * 0.25;
    float b = o.x * d.x + o.z * d.z + s0 * d.y * 0.25;
    float c = o.x * o.x + o.z * o.z - s0 * s0 * 0.25;
    if (abs(a) > 1e-12) {
      float disc = b * b - a * c;
      if (disc >= 0.0) {
        float s = sqrt(disc);
        for (int k = 0; k < 2; k++) {
          float t = (-b + (k == 0 ? -s : s)) / a;
          vec3 p = o + d * t;
          if (p.y >= -0.5 && p.y <= 0.5) considerRoot(t, vec3(2.0 * p.x, (0.5 - p.y) * 0.5, 2.0 * p.z), tMin, best, bestN);
        }
      }
    }
    if (abs(d.y) > 1e-12) {
      float t = (-0.5 - o.y) / d.y;
      vec3 p = o + d * t;
      if (p.x * p.x + p.z * p.z <= 0.25) considerRoot(t, vec3(0.0, -1.0, 0.0), tMin, best, bestN);
    }
  } else {
    if (abs(d.y) < 1e-12) return false;
    float t = -o.y / d.y;
    vec3 p = o + d * t;
    bool inside = shape == SHAPE_PLANE ? (abs(p.x) <= 0.5 && abs(p.z) <= 0.5) : (p.x * p.x + p.z * p.z <= 0.25);
    if (inside) considerRoot(t, vec3(0.0, 1.0, 0.0), tMin, best, bestN);
  }

  if (best < tMax) {
    tHit = best;
    nLocal = bestN;
    return true;
  }
  return false;
}

/** Ray against a bounding sphere: false when the sphere is missed or entirely farther than tMax. */
bool boundCheck(vec3 ro, vec3 rd, vec4 bound, float tMax) {
  vec3 oc = ro - bound.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - bound.w * bound.w;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  return -b + s > 0.0 && -b - s < tMax;
}

/** Visible emitter geometry: area rectangles (front side only) and spheres. */
bool intersectLight(int i, vec3 ro, vec3 rd, float tMax, out float tHit, out vec3 n) {
  vec4 t0 = lightTexel(i, 0);
  int type = int(t0.x + 0.5);
  if (t0.y < 0.5) return false;
  vec4 t1 = lightTexel(i, 1);
  if (type == LIGHT_AREA) {
    vec3 u = lightTexel(i, 2).xyz;
    vec3 v = lightTexel(i, 3).xyz;
    vec3 normal = normalize(cross(u, v));
    float denom = dot(rd, normal);
    if (denom >= -1e-7) return false;
    float t = dot(t1.xyz - ro, normal) / denom;
    if (t <= 1e-5 || t >= tMax) return false;
    vec3 rel = ro + rd * t - t1.xyz;
    if (abs(dot(rel, u)) > dot(u, u) || abs(dot(rel, v)) > dot(v, v)) return false;
    tHit = t;
    n = normal;
    return true;
  }
  if (type == LIGHT_SPHERE) {
    vec3 oc = ro - t1.xyz;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - t1.w * t1.w;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float s = sqrt(disc);
    float t = -b - s;
    if (t <= 1e-5) return false;
    if (t >= tMax) return false;
    tHit = t;
    n = (ro + rd * t - t1.xyz) / t1.w;
    return true;
  }
  return false;
}

Hit traceScene(vec3 ro, vec3 rd) {
  Hit hit;
  hit.t = INF;
  hit.normal = vec3(0.0, 1.0, 0.0);
  hit.localP = vec3(0.0);
  hit.material = -1;
  hit.light = -1;

  for (int i = 0; i < uObjectCount; i++) {
    if (!boundCheck(ro, rd, objectTexel(i, 4), hit.t)) continue;
    vec4 r0 = objectTexel(i, 1);
    vec4 r1 = objectTexel(i, 2);
    vec4 r2 = objectTexel(i, 3);
    vec3 o = vec3(dot(r0.xyz, ro) + r0.w, dot(r1.xyz, ro) + r1.w, dot(r2.xyz, ro) + r2.w);
    vec3 d = vec3(dot(r0.xyz, rd), dot(r1.xyz, rd), dot(r2.xyz, rd));
    float t;
    vec3 nl;
    if (intersectShape(int(objectTexel(i, 0).x + 0.5), o, d, hit.t, t, nl)) {
      hit.t = t;
      hit.normal = normalize(nl.x * r0.xyz + nl.y * r1.xyz + nl.z * r2.xyz);
      hit.localP = (o + d * t) * objectTexel(i, 5).xyz;
      hit.material = int(objectTexel(i, 0).y + 0.5);
      hit.light = -1;
    }
  }

  for (int i = 0; i < uLightCount; i++) {
    float t;
    vec3 n;
    if (intersectLight(i, ro, rd, hit.t, t, n)) {
      hit.t = t;
      hit.normal = n;
      hit.light = i;
      hit.material = -1;
    }
  }
  return hit;
}

/** Any-hit query for shadow rays. Lights only block other lights when visible. */
bool occluded(vec3 ro, vec3 rd, float maxT) {
  for (int i = 0; i < uObjectCount; i++) {
    if (!boundCheck(ro, rd, objectTexel(i, 4), maxT)) continue;
    vec4 r0 = objectTexel(i, 1);
    vec4 r1 = objectTexel(i, 2);
    vec4 r2 = objectTexel(i, 3);
    vec3 o = vec3(dot(r0.xyz, ro) + r0.w, dot(r1.xyz, ro) + r1.w, dot(r2.xyz, ro) + r2.w);
    vec3 d = vec3(dot(r0.xyz, rd), dot(r1.xyz, rd), dot(r2.xyz, rd));
    float t;
    vec3 nl;
    if (intersectShape(int(objectTexel(i, 0).x + 0.5), o, d, maxT, t, nl)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- environment

vec3 environment(vec3 d) {
  if (uEnvType == 0) return uEnvA;
  if (d.y >= 0.0) return mix(uEnvB, uEnvA, pow(d.y, 0.6));
  return mix(uEnvB, uEnvC, pow(-d.y, 0.4));
}

// ---------------------------------------------------------------- microfacet BSDF

vec3 fresnelSchlick(vec3 f0, float cosT) {
  float m = clamp(1.0 - cosT, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

float fresnelDielectric(float cosI, float eta) {
  // eta = n_incident / n_transmitted
  float sinT2 = eta * eta * (1.0 - cosI * cosI);
  if (sinT2 >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - sinT2);
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

float ggxD(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

float smithG1(float NoX, float a) {
  float a2 = a * a;
  return 2.0 * NoX / (NoX + sqrt(a2 + (1.0 - a2) * NoX * NoX));
}

/** Visible normal sampling (Heitz 2018). v is in tangent space with z up. */
vec3 sampleVndf(vec3 v, float a, vec2 u) {
  vec3 vh = normalize(vec3(a * v.x, a * v.y, v.z));
  float lensq = vh.x * vh.x + vh.y * vh.y;
  vec3 t1 = lensq > 0.0 ? vec3(-vh.y, vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
  vec3 t2 = cross(vh, t1);
  float r = sqrt(u.x);
  float phi = TWO_PI * u.y;
  float p1 = r * cos(phi);
  float p2 = r * sin(phi);
  float s = 0.5 * (1.0 + vh.z);
  p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * p2;
  vec3 nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3(a * nh.x, a * nh.y, max(1e-6, nh.z)));
}

/** pdf of a reflected direction drawn with VNDF sampling. */
float vndfReflectPdf(float NoV, float NoH, float a) {
  return smithG1(NoV, a) * ggxD(NoH, a) / (4.0 * NoV);
}

float alphaOf(float roughness) {
  return max(1e-3, roughness * roughness);
}

/** Lobe selection probabilities for the current view direction. */
struct Lobes {
  float diffuse;
  float specular;
  float clearcoat;
  float transmission;
  vec3 f0;
  float opaque;      // energy of the opaque (non transmissive) part
  float diffuseWeight;
  float transWeight; // energy of the transmissive part
};

Lobes lobes(Material m, float NoV) {
  Lobes l;
  l.f0 = mix(vec3(0.08 * m.specular), m.base, m.metallic);
  float trans = (1.0 - m.metallic) * m.transmission;
  l.opaque = 1.0 - trans;
  l.transWeight = trans;
  l.diffuseWeight = (1.0 - m.metallic) * (1.0 - m.transmission);
  float wd = l.diffuseWeight * luminance(m.base);
  float ws = l.opaque * luminance(fresnelSchlick(l.f0, NoV));
  float wc = m.clearcoat * 0.25;
  float wt = trans;
  float sum = wd + ws + wc + wt;
  if (sum <= 0.0) {
    l.diffuse = 1.0;
    l.specular = 0.0;
    l.clearcoat = 0.0;
    l.transmission = 0.0;
    return l;
  }
  l.diffuse = wd / sum;
  l.specular = ws / sum;
  l.clearcoat = wc / sum;
  l.transmission = wt / sum;
  return l;
}

/**
 * Reflection part of the BSDF times the cosine term, for directions above the surface.
 * pdf receives the density of producing wi with the reflective lobes (used by MIS).
 */
vec3 evalReflection(Material m, Lobes l, vec3 n, vec3 wo, vec3 wi, out float pdf) {
  pdf = 0.0;
  float NoL = dot(n, wi);
  float NoV = dot(n, wo);
  if (NoL <= 0.0 || NoV <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wi);
  float NoH = max(dot(n, h), 0.0);
  float VoH = max(dot(wo, h), 0.0);

  float a = alphaOf(m.roughness);
  vec3 F = fresnelSchlick(l.f0, VoH);
  float D = ggxD(NoH, a);
  float G = smithG1(NoV, a) * smithG1(NoL, a);
  vec3 spec = l.opaque * F * D * G / (4.0 * NoV * NoL);

  float ac = alphaOf(m.clearcoatRoughness);
  float Fc = fresnelSchlick(vec3(0.04), VoH).x * m.clearcoat;
  float Dc = ggxD(NoH, ac);
  float coat = Fc * Dc * smithG1(NoV, ac) * smithG1(NoL, ac) / (4.0 * NoV * NoL);

  vec3 diffuse = l.diffuseWeight * m.base * INV_PI * (1.0 - F);

  pdf = l.diffuse * NoL * INV_PI
      + l.specular * vndfReflectPdf(NoV, NoH, a)
      + l.clearcoat * vndfReflectPdf(NoV, NoH, ac);
  return ((diffuse + spec) * (1.0 - Fc) + coat) * NoL;
}

// ---------------------------------------------------------------- lights

struct LightSample {
  vec3 wi;
  float dist;
  vec3 radiance;
  float pdf;    // solid angle pdf, excluding the light selection probability
  bool delta;   // cannot be hit by BSDF rays: no MIS
};

bool sampleLight(int i, vec3 p, out LightSample s) {
  vec4 t0 = lightTexel(i, 0);
  vec4 t1 = lightTexel(i, 1);
  vec4 t4 = lightTexel(i, 4);
  int type = int(t0.x + 0.5);
  s.radiance = t4.rgb;
  s.delta = t0.y < 0.5;

  if (type == LIGHT_AREA) {
    vec3 u = lightTexel(i, 2).xyz;
    vec3 v = lightTexel(i, 3).xyz;
    vec2 r = rand2() * 2.0 - 1.0;
    vec3 q = t1.xyz + u * r.x + v * r.y;
    vec3 d = q - p;
    float dist2 = dot(d, d);
    s.dist = sqrt(dist2);
    s.wi = d / s.dist;
    float cosL = -dot(s.wi, normalize(cross(u, v)));
    if (cosL <= 0.0) return false;
    s.pdf = dist2 / (cosL * t4.a);
    return true;
  }
  if (type == LIGHT_SPHERE) {
    vec3 d = t1.xyz - p;
    float dc2 = dot(d, d);
    float r2 = t1.w * t1.w;
    if (dc2 <= r2) return false;
    float dc = sqrt(dc2);
    float sin2 = r2 / dc2;
    float omc = sin2 / (1.0 + sqrt(1.0 - sin2)); // 1 - cos(theta max), stable
    s.wi = sampleCone(d / dc, omc);
    // Distance to the near side of the sphere along wi.
    float b = dot(s.wi, d);
    s.dist = b - sqrt(max(0.0, r2 - (dc2 - b * b)));
    s.pdf = 1.0 / (TWO_PI * omc);
    return true;
  }
  if (type == LIGHT_POINT) {
    vec3 d = t1.xyz - p;
    float dist2 = max(dot(d, d), 1e-8);
    s.dist = sqrt(dist2);
    s.wi = d / s.dist;
    s.radiance = t4.rgb / dist2;
    s.pdf = 1.0;
    s.delta = true;
    return true;
  }
  // Sun: t1.xyz is the direction towards the sun.
  s.dist = INF;
  if (t0.w > 0.0) {
    s.wi = sampleCone(t1.xyz, t0.w);
    s.pdf = 1.0 / (TWO_PI * t0.w);
  } else {
    s.wi = t1.xyz;
    s.pdf = 1.0;
    s.delta = true;
  }
  return true;
}

/** Solid angle pdf of light i producing direction rd from p, for a BSDF ray that hit it at distance t. */
float lightPdf(int i, vec3 p, vec3 rd, float t, vec3 n) {
  vec4 t0 = lightTexel(i, 0);
  int type = int(t0.x + 0.5);
  if (type == LIGHT_AREA) {
    float cosL = max(-dot(rd, n), 1e-6);
    return t * t / (cosL * lightTexel(i, 4).a);
  }
  if (type == LIGHT_SPHERE) {
    vec4 t1 = lightTexel(i, 1);
    vec3 d = t1.xyz - p;
    float dc2 = dot(d, d);
    float sin2 = min(t1.w * t1.w / dc2, 1.0);
    float omc = sin2 / (1.0 + sqrt(1.0 - sin2));
    return 1.0 / (TWO_PI * max(omc, 1e-9));
  }
  if (type == LIGHT_SUN) return 1.0 / (TWO_PI * t0.w);
  return 0.0;
}

/** Radiance of the sky plus the sun disks, for a ray that escaped the scene. */
vec3 escaped(vec3 rd, vec3 p, float lastPdf, bool lastSpecular, float selectPdf) {
  vec3 color = environment(rd);
  for (int i = 0; i < uLightCount; i++) {
    vec4 t0 = lightTexel(i, 0);
    if (int(t0.x + 0.5) != LIGHT_SUN || t0.w <= 0.0 || t0.y < 0.5) continue;
    if (dot(rd, lightTexel(i, 1).xyz) < t0.z) continue;
    float w = lastSpecular ? 1.0 : powerHeuristic(lastPdf, lightPdf(i, p, rd, INF, vec3(0.0)) * selectPdf);
    color += lightTexel(i, 4).rgb * w;
  }
  return color;
}

// ---------------------------------------------------------------- path

vec3 radiance(vec3 ro, vec3 rd) {
  vec3 color = vec3(0.0);
  vec3 throughput = vec3(1.0);
  float lastPdf = 0.0;
  bool lastSpecular = true;
  float selectPdf = uLightCount > 0 ? 1.0 / float(uLightCount) : 0.0;

  for (int bounce = 0; bounce < MAX_BOUNCES_LIMIT; bounce++) {
    if (bounce >= uMaxBounces) break;
    Hit hit = traceScene(ro, rd);

    if (hit.t >= INF) {
      color += throughput * escaped(rd, ro, lastPdf, lastSpecular, selectPdf);
      break;
    }

    vec3 p = ro + rd * hit.t;

    if (hit.light >= 0) {
      float w = lastSpecular ? 1.0 : powerHeuristic(lastPdf, lightPdf(hit.light, ro, rd, hit.t, hit.normal) * selectPdf);
      color += throughput * lightTexel(hit.light, 4).rgb * w;
      break;
    }

    Material m = loadMaterial(hit.material, hit.localP);
    color += throughput * m.emission;

    vec3 wo = -rd;
    vec3 ng = hit.normal;
    bool entering = dot(wo, ng) > 0.0;
    vec3 n = entering ? ng : -ng; // faces the viewer
    float NoV = max(dot(n, wo), 1e-4);
    Lobes l = lobes(m, NoV);
    float eps = 1e-4 * (1.0 + max(max(abs(p.x), abs(p.y)), abs(p.z)));

    // Next event estimation through the reflective lobes.
    bool reflective = l.transmission < 1.0;
    if (uLightCount > 0 && reflective) {
      int li = min(int(rand() * float(uLightCount)), uLightCount - 1);
      LightSample ls;
      if (sampleLight(li, p, ls) && dot(ls.wi, n) > 0.0) {
        float bsdfPdf;
        vec3 f = evalReflection(m, l, n, wo, ls.wi, bsdfPdf);
        if (max(f.r, max(f.g, f.b)) > 0.0) {
          vec3 origin = p + n * eps;
          float maxT = ls.dist >= INF ? INF : ls.dist * (1.0 - 1e-3) - eps;
          if (!occluded(origin, ls.wi, maxT)) {
            float lp = ls.pdf * selectPdf;
            float w = ls.delta ? 1.0 : powerHeuristic(lp, bsdfPdf);
            color += throughput * f * ls.radiance * w / lp;
          }
        }
      }
    }

    // Sample the next direction.
    float u = rand();
    vec3 wi;
    if (u < l.transmission) {
      // Rough dielectric: pick a microfacet, then reflect or refract with the exact Fresnel term.
      float a = alphaOf(m.roughness);
      float eta = entering ? 1.0 / m.ior : m.ior;
      vec3 mh = toWorld(sampleVndf(toLocal(wo, n), a, rand2()), n);
      float cosI = dot(wo, mh);
      float F = fresnelDielectric(cosI, eta);
      bool refracted = false;
      if (rand() >= F) {
        wi = refract(-wo, mh, eta);
        refracted = dot(wi, wi) > 0.0;
      }
      if (!refracted) wi = reflect(-wo, mh);
      float NoL = dot(n, wi);
      if (refracted ? NoL >= 0.0 : NoL <= 0.0) break;
      throughput *= smithG1(abs(NoL), a) * l.transWeight / l.transmission;
      if (refracted && entering) throughput *= m.base;
      ro = p + (refracted ? -n : n) * eps;
      lastSpecular = true;
    } else {
      float v = (u - l.transmission) / max(1.0 - l.transmission, 1e-6);
      float pd = l.diffuse / max(1.0 - l.transmission, 1e-6);
      float ps = l.specular / max(1.0 - l.transmission, 1e-6);
      if (v < pd) {
        wi = sampleCosine(n);
      } else if (v < pd + ps) {
        vec3 mh = toWorld(sampleVndf(toLocal(wo, n), alphaOf(m.roughness), rand2()), n);
        wi = reflect(-wo, mh);
      } else {
        vec3 mh = toWorld(sampleVndf(toLocal(wo, n), alphaOf(m.clearcoatRoughness), rand2()), n);
        wi = reflect(-wo, mh);
      }
      float pdf;
      vec3 f = evalReflection(m, l, n, wo, wi, pdf);
      if (pdf <= 0.0) break;
      throughput *= f / pdf;
      ro = p + n * eps;
      lastPdf = pdf;
      lastSpecular = false;
    }
    rd = wi;

    // Russian roulette keeps the estimator unbiased while cutting long, dim paths.
    if (bounce > 2) {
      float survive = min(max(throughput.r, max(throughput.g, throughput.b)), 0.95);
      if (rand() > survive) break;
      throughput /= survive;
    }
  }
  return color;
}

void main() {
  uvec2 pixel = uvec2(gl_FragCoord.xy);
  rngState = pcgHash(pixel.x * 1973u + pixel.y * 9277u + uSeed * 26699u) | 1u;

  vec2 jitter = rand2();
  vec2 ndc = (gl_FragCoord.xy - 0.5 + jitter) / uResolution * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  // Vertical field of view in landscape, horizontal in portrait (see viewTanHalf in camera.ts).
  float tanHalf = aspect < 1.0 ? uTanHalfFov / aspect : uTanHalfFov;
  vec3 dir = normalize(uCamForward + uCamRight * (ndc.x * tanHalf * aspect) + uCamUp * (ndc.y * tanHalf));

  vec3 origin = uCamPos;
  if (uAperture > 0.0) {
    vec3 focusPoint = origin + dir * (uFocusDistance / dot(dir, uCamForward));
    vec2 lens = sampleDisk(rand2()) * uAperture;
    origin += uCamRight * lens.x + uCamUp * lens.y;
    dir = normalize(focusPoint - origin);
  }

  vec3 sampleColor = radiance(origin, dir);
  if (any(isnan(sampleColor)) || any(isinf(sampleColor))) sampleColor = vec3(0.0);
  float lum = luminance(sampleColor);
  if (uClamp > 0.0 && lum > uClamp) sampleColor *= uClamp / lum;

  vec3 previous = uSamples > 0.0 ? texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb : vec3(0.0);
  fragColor = vec4(mix(previous, sampleColor, 1.0 / (uSamples + 1.0)), 1.0);
}
