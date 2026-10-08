#version 300 es
// One Monte Carlo sample per pixel per frame, blended into a running average.
precision highp float;
precision highp int;

#define MAX_SPHERES 8
#define MAX_BOXES 8
#define MAX_BOUNCES 8
#define PI 3.14159265359
#define EPS 1e-4

#define DIFFUSE 0
#define METAL 1
#define GLASS 2
#define LIGHT 3

uniform sampler2D uAccum;
uniform vec2 uResolution;
uniform float uSamples;
uniform uint uSeed;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;
uniform float uAperture;
uniform float uFocusDistance;

uniform vec3 uRoomMin;
uniform vec3 uRoomMax;
// floor, ceiling, back, left, right
uniform vec3 uWalls[5];

uniform vec2 uLightPos;
uniform vec2 uLightHalf;
uniform vec3 uLightEmission;

uniform int uSphereCount;
uniform vec4 uSpheres[MAX_SPHERES];
uniform vec4 uSphereMaterials[MAX_SPHERES];
uniform vec2 uSphereParams[MAX_SPHERES];

uniform int uBoxCount;
uniform vec3 uBoxMin[MAX_BOXES];
uniform vec3 uBoxMax[MAX_BOXES];
uniform vec4 uBoxMaterials[MAX_BOXES];
uniform vec2 uBoxParams[MAX_BOXES];

out vec4 fragColor;

struct Hit {
  float t;
  vec3 normal;
  vec3 albedo;
  int type;
  float roughness;
  float ior;
};

// ---------------------------------------------------------------- random

uint rngState;

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float random01() {
  rngState = pcgHash(rngState);
  return float(rngState) * (1.0 / 4294967296.0);
}

vec2 randomInDisk() {
  float r = sqrt(random01());
  float a = 2.0 * PI * random01();
  return r * vec2(cos(a), sin(a));
}

vec3 randomInSphere() {
  float z = 2.0 * random01() - 1.0;
  float a = 2.0 * PI * random01();
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z) * pow(random01(), 1.0 / 3.0);
}

vec3 cosineHemisphere(vec3 n) {
  float u1 = random01();
  float u2 = random01();
  float r = sqrt(u1);
  float phi = 2.0 * PI * u2;
  vec3 a = abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, n));
  vec3 b = cross(n, t);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u1)));
}

// ---------------------------------------------------------------- geometry

bool insideRange(float v, float lo, float hi) {
  return v >= lo - EPS && v <= hi + EPS;
}

void hitWall(inout Hit hit, float t, vec3 p, vec3 normal, vec3 albedo, bool inBounds) {
  if (t > EPS && t < hit.t && inBounds) {
    hit.t = t;
    hit.normal = normal;
    hit.albedo = albedo;
    hit.type = DIFFUSE;
  }
}

void intersectRoom(vec3 ro, vec3 rd, inout Hit hit) {
  vec3 lo = uRoomMin;
  vec3 hi = uRoomMax;
  float t;
  vec3 p;
  if (rd.y < 0.0) {
    t = (lo.y - ro.y) / rd.y; p = ro + rd * t;
    hitWall(hit, t, p, vec3(0, 1, 0), uWalls[0], insideRange(p.x, lo.x, hi.x) && insideRange(p.z, lo.z, hi.z));
  }
  if (rd.y > 0.0) {
    t = (hi.y - ro.y) / rd.y; p = ro + rd * t;
    bool inBounds = insideRange(p.x, lo.x, hi.x) && insideRange(p.z, lo.z, hi.z);
    if (t > EPS && t < hit.t && inBounds) {
      hit.t = t;
      hit.normal = vec3(0, -1, 0);
      bool onLight = abs(p.x - uLightPos.x) < uLightHalf.x && abs(p.z - uLightPos.y) < uLightHalf.y;
      hit.type = onLight ? LIGHT : DIFFUSE;
      hit.albedo = uWalls[1];
    }
  }
  if (rd.z < 0.0) {
    t = (lo.z - ro.z) / rd.z; p = ro + rd * t;
    hitWall(hit, t, p, vec3(0, 0, 1), uWalls[2], insideRange(p.x, lo.x, hi.x) && insideRange(p.y, lo.y, hi.y));
  }
  if (rd.x < 0.0) {
    t = (lo.x - ro.x) / rd.x; p = ro + rd * t;
    hitWall(hit, t, p, vec3(1, 0, 0), uWalls[3], insideRange(p.y, lo.y, hi.y) && insideRange(p.z, lo.z, hi.z));
  }
  if (rd.x > 0.0) {
    t = (hi.x - ro.x) / rd.x; p = ro + rd * t;
    hitWall(hit, t, p, vec3(-1, 0, 0), uWalls[4], insideRange(p.y, lo.y, hi.y) && insideRange(p.z, lo.z, hi.z));
  }
}

void setMaterial(inout Hit hit, vec4 material, vec2 params) {
  hit.albedo = material.rgb;
  hit.type = int(material.a + 0.5);
  hit.roughness = params.x;
  hit.ior = params.y;
}

void intersectSphere(vec3 ro, vec3 rd, int i, inout Hit hit) {
  vec3 center = uSpheres[i].xyz;
  float radius = uSpheres[i].w;
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return;
  float s = sqrt(disc);
  float t = -b - s;
  if (t < EPS) t = -b + s;
  if (t > EPS && t < hit.t) {
    hit.t = t;
    hit.normal = (ro + rd * t - center) / radius;
    setMaterial(hit, uSphereMaterials[i], uSphereParams[i]);
  }
}

void intersectBox(vec3 ro, vec3 rd, int i, inout Hit hit) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin[i] - ro) * inv;
  vec3 t1 = (uBoxMax[i] - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), tmin.z);
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  if (tNear > tFar || tFar < EPS) return;
  bool inside = tNear < EPS;
  float t = inside ? tFar : tNear;
  if (t >= hit.t) return;
  vec3 axis = inside
    ? step(tmax, vec3(tFar) + EPS) * step(vec3(tFar) - EPS, tmax)
    : step(tmin, vec3(tNear) + EPS) * step(vec3(tNear) - EPS, tmin);
  hit.t = t;
  hit.normal = normalize(-sign(rd) * axis) * (inside ? -1.0 : 1.0);
  setMaterial(hit, uBoxMaterials[i], uBoxParams[i]);
}

Hit traceScene(vec3 ro, vec3 rd) {
  Hit hit;
  hit.t = 1e20;
  hit.type = -1;
  hit.normal = vec3(0);
  hit.albedo = vec3(0);
  hit.roughness = 0.0;
  hit.ior = 1.0;
  intersectRoom(ro, rd, hit);
  for (int i = 0; i < MAX_SPHERES; i++) {
    if (i >= uSphereCount) break;
    intersectSphere(ro, rd, i, hit);
  }
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uBoxCount) break;
    intersectBox(ro, rd, i, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- shading

/** Next event estimation: one shadow ray towards a random point on the area light. */
vec3 sampleLight(vec3 p, vec3 n) {
  vec3 target = vec3(
    uLightPos.x + (2.0 * random01() - 1.0) * uLightHalf.x,
    uRoomMax.y - EPS * 10.0,
    uLightPos.y + (2.0 * random01() - 1.0) * uLightHalf.y
  );
  vec3 toLight = target - p;
  float dist2 = dot(toLight, toLight);
  float dist = sqrt(dist2);
  vec3 dir = toLight / dist;
  float cosSurface = dot(n, dir);
  float cosLight = dir.y;
  if (cosSurface <= 0.0 || cosLight <= 0.0) return vec3(0);
  Hit shadow = traceScene(p, dir);
  if (shadow.type != LIGHT && shadow.t < dist * 0.999) return vec3(0);
  float area = 4.0 * uLightHalf.x * uLightHalf.y;
  return uLightEmission * cosSurface * cosLight * area / (dist2 * PI);
}

vec3 radiance(vec3 ro, vec3 rd) {
  vec3 color = vec3(0);
  vec3 throughput = vec3(1);
  bool countEmission = true;

  for (int bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    Hit hit = traceScene(ro, rd);
    if (hit.type < 0) break;

    vec3 p = ro + rd * hit.t;
    vec3 n = hit.normal;

    if (hit.type == LIGHT) {
      if (countEmission) color += throughput * uLightEmission;
      break;
    }

    if (hit.type == DIFFUSE) {
      color += throughput * hit.albedo * sampleLight(p, n);
      throughput *= hit.albedo;
      rd = cosineHemisphere(n);
      countEmission = false;
    } else if (hit.type == METAL) {
      vec3 reflected = reflect(rd, n);
      rd = normalize(reflected + hit.roughness * randomInSphere());
      if (dot(rd, n) <= 0.0) break;
      throughput *= hit.albedo;
      countEmission = true;
    } else {
      float cosIncident = dot(rd, n);
      float eta = 1.0 / hit.ior;
      if (cosIncident > 0.0) {
        n = -n;
        eta = hit.ior;
      } else {
        cosIncident = -cosIncident;
      }
      float k = 1.0 - eta * eta * (1.0 - cosIncident * cosIncident);
      float r0 = (1.0 - hit.ior) / (1.0 + hit.ior);
      r0 *= r0;
      float fresnel = r0 + (1.0 - r0) * pow(1.0 - cosIncident, 5.0);
      if (k < 0.0 || random01() < fresnel) {
        rd = reflect(rd, n);
      } else {
        rd = normalize(eta * rd + (eta * cosIncident - sqrt(k)) * n);
      }
      throughput *= hit.albedo;
      countEmission = true;
    }
    ro = p;

    // Russian roulette after a few bounces keeps the estimator unbiased.
    if (bounce > 2) {
      float survive = max(throughput.r, max(throughput.g, throughput.b));
      if (random01() > survive) break;
      throughput /= survive;
    }
  }
  return color;
}

void main() {
  uvec2 pixel = uvec2(gl_FragCoord.xy);
  rngState = pcgHash(pixel.x * 1973u + pixel.y * 9277u + uSeed * 26699u) | 1u;

  vec2 jitter = vec2(random01(), random01());
  vec2 ndc = (gl_FragCoord.xy - 0.5 + jitter) / uResolution * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(uCamForward + uCamRight * (ndc.x * uTanHalfFov * aspect) + uCamUp * (ndc.y * uTanHalfFov));

  vec3 origin = uCamPos;
  if (uAperture > 0.0) {
    vec3 focusPoint = origin + dir * uFocusDistance;
    vec2 lens = randomInDisk() * uAperture;
    origin += uCamRight * lens.x + uCamUp * lens.y;
    dir = normalize(focusPoint - origin);
  }

  vec3 sampleColor = radiance(origin, dir);
  // Clamp rare high-energy paths (fireflies) so they do not dominate early frames.
  float luminance = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
  if (luminance > 8.0) sampleColor *= 8.0 / luminance;

  vec3 previous = uSamples > 0.0 ? texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb : vec3(0);
  fragColor = vec4(mix(previous, sampleColor, 1.0 / (uSamples + 1.0)), 1.0);
}
