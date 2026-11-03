// GLSL (WebGL2) sources of the path tracer: one full-screen fragment shader traces one sample per
// pixel (camera ray, BVH traversal, BSDF sampling, next-event estimation with multiple importance
// sampling, Russian roulette) and folds it into a running mean; a display shader applies exposure
// and the sRGB view transform; a filter shader implements the optional denoiser.

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const TRACE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

#define TEX_W 2048
#define TEX_SHIFT 11
#define PI 3.14159265358979
#define INV_PI 0.31830988618379
#define STACK 40

uniform sampler2D uTri, uVtx, uBvh, uMat, uLeaf, uTexRec, uLights, uEmit;
uniform sampler2DArray uImages;
uniform sampler2D uPrevColor, uPrevAlbedo, uPrevNormal;

uniform mat4 uInvViewProj;
uniform vec2 uRes;
uniform int uSample, uSeed;
uniform float uBlend;
uniform int uTriCount, uLightCount, uEmitCount, uHasTransparent;
uniform float uEmitTotal, uMeshLightProb;
uniform int uMaxBounces, uMinBounces, uDiffuseBounces, uGlossyBounces, uTransBounces, uTranspMax, uTranspMin;
uniform float uClampDirect, uClampIndirect, uBlurGlossy;
uniform int uCausticsRefl, uCausticsRefr, uTransparentShadows;
uniform int uFilterType;
uniform float uFilterWidth;
uniform int uFilmTransparent;
uniform int uWorldMode, uWorldVisible;
uniform vec3 uHorizon, uZenith;
uniform float uWorldStrength;
uniform int uUseAO;
uniform float uAOFactor, uAODist;
uniform float uEps;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oAlbedo;
layout(location = 2) out vec4 oNormal;

// ------------------------------------------------------------------ random numbers (PCG)

uint rngState;
uint pcgHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd() {
  rngState = rngState * 747796405u + 2891336453u;
  uint s = rngState;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  w = (w >> 22u) ^ w;
  return float(w >> 8u) * (1.0 / 16777216.0);
}
vec2 rnd2() { return vec2(rnd(), rnd()); }

// ------------------------------------------------------------------ data access

vec4 fetch(sampler2D t, int i) { return texelFetch(t, ivec2(i & (TEX_W - 1), i >> TEX_SHIFT), 0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float max3(vec3 c) { return max(c.x, max(c.y, c.z)); }

void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 cosineSample(vec3 n, vec2 u) {
  float r = sqrt(u.x), phi = 2.0 * PI * u.y;
  vec3 t, b; basis(n, t, b);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u.x)));
}

vec3 coneSample(vec3 n, float cosMax, vec2 u) {
  float c = 1.0 - u.x * (1.0 - cosMax);
  float s = sqrt(max(0.0, 1.0 - c * c));
  float phi = 2.0 * PI * u.y;
  vec3 t, b; basis(n, t, b);
  return normalize(t * (s * cos(phi)) + b * (s * sin(phi)) + n * c);
}

// ------------------------------------------------------------------ ray / scene intersection

float hitBox(vec3 bmin, vec3 bmax, vec3 ro, vec3 inv, float tmax) {
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float a = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float b = min(min(tf.x, tf.y), min(tf.z, tmax));
  return a <= b ? a : 1e30;
}

vec3 safeInv(vec3 d) {
  return 1.0 / vec3(abs(d.x) < 1e-12 ? 1e-12 : d.x, abs(d.y) < 1e-12 ? 1e-12 : d.y, abs(d.z) < 1e-12 ? 1e-12 : d.z);
}

// closest hit: returns the triangle index (-1 = miss); t and barycentrics in out params
int traceClosest(vec3 ro, vec3 rd, float tmax, out float tHit, out vec2 bary) {
  tHit = tmax;
  bary = vec2(0.0);
  if (uTriCount == 0) return -1;
  vec3 inv = safeInv(rd);
  int stack[STACK];
  int sp = 0;
  stack[sp++] = 0;
  int best = -1;
  for (int it = 0; it < 200000; it++) {
    if (sp == 0) break;
    int node = stack[--sp];
    vec4 a = fetch(uBvh, node * 2), b = fetch(uBvh, node * 2 + 1);
    if (hitBox(a.xyz, b.xyz, ro, inv, tHit) > tHit) continue;
    if (b.w > 0.0) {
      int start = int(a.w), cnt = int(b.w);
      for (int i = 0; i < cnt; i++) {
        int ti = start + i;
        vec3 v0 = fetch(uTri, ti * 3).xyz, e1 = fetch(uTri, ti * 3 + 1).xyz, e2 = fetch(uTri, ti * 3 + 2).xyz;
        vec3 p = cross(rd, e2);
        float det = dot(e1, p);
        if (abs(det) < 1e-14) continue;
        float id = 1.0 / det;
        vec3 s = ro - v0;
        float u = dot(s, p) * id;
        if (u < 0.0 || u > 1.0) continue;
        vec3 q = cross(s, e1);
        float v = dot(rd, q) * id;
        if (v < 0.0 || u + v > 1.0) continue;
        float t = dot(e2, q) * id;
        if (t > 0.0 && t < tHit) { tHit = t; best = ti; bary = vec2(u, v); }
      }
    } else {
      int axis = int(-b.w) - 1;
      int l = node + 1, r = int(a.w);
      if (sp > STACK - 2) continue;
      if (rd[axis] < 0.0) { stack[sp++] = l; stack[sp++] = r; }
      else { stack[sp++] = r; stack[sp++] = l; }
    }
  }
  return best;
}

bool occludedAny(vec3 ro, vec3 rd, float tmax) {
  if (uTriCount == 0) return false;
  vec3 inv = safeInv(rd);
  int stack[STACK];
  int sp = 0;
  stack[sp++] = 0;
  for (int it = 0; it < 200000; it++) {
    if (sp == 0) break;
    int node = stack[--sp];
    vec4 a = fetch(uBvh, node * 2), b = fetch(uBvh, node * 2 + 1);
    if (hitBox(a.xyz, b.xyz, ro, inv, tmax) > tmax) continue;
    if (b.w > 0.0) {
      int start = int(a.w), cnt = int(b.w);
      for (int i = 0; i < cnt; i++) {
        int ti = start + i;
        vec3 v0 = fetch(uTri, ti * 3).xyz, e1 = fetch(uTri, ti * 3 + 1).xyz, e2 = fetch(uTri, ti * 3 + 2).xyz;
        vec3 p = cross(rd, e2);
        float det = dot(e1, p);
        if (abs(det) < 1e-14) continue;
        float id = 1.0 / det;
        vec3 s = ro - v0;
        float u = dot(s, p) * id;
        if (u < 0.0 || u > 1.0) continue;
        vec3 q = cross(s, e1);
        float v = dot(rd, q) * id;
        if (v < 0.0 || u + v > 1.0) continue;
        float t = dot(e2, q) * id;
        if (t > 0.0 && t < tmax) return true;
      }
    } else {
      int axis = int(-b.w) - 1;
      int l = node + 1, r = int(a.w);
      if (sp > STACK - 2) continue;
      if (rd[axis] < 0.0) { stack[sp++] = l; stack[sp++] = r; }
      else { stack[sp++] = r; stack[sp++] = l; }
    }
  }
  return false;
}

// ------------------------------------------------------------------ textures

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float gnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0)), u.x),
                 mix(dot(hash3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)), dot(hash3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)), dot(hash3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1)), u.x),
                 mix(dot(hash3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)), dot(hash3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1)), u.x), u.y), u.z);
}
float noise01(vec3 p, bool hard) { float n = gnoise(p) * 0.5 + 0.5; return hard ? abs(2.0 * n - 1.0) : n; }
float turb(vec3 p, int depth, bool hard) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 8; i++) { if (i > depth) break; sum += amp * noise01(p, hard); norm += amp; amp *= 0.5; p *= 2.0; }
  return sum / norm;
}
float voronoiF1(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 r = g + hash3(i + g) * 0.5 + 0.5 - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
vec2 project(vec3 co, int mapping) {
  if (mapping == 1) { vec3 a = abs(co); if (a.x >= a.y && a.x >= a.z) return co.yz; if (a.y >= a.z) return co.xz; return co.xy; }
  if (mapping == 2) { float u = atan(co.x, -co.y) / PI; return vec2(u, co.z); }
  if (mapping == 3) { float u = atan(co.x, -co.y) / PI; float l = length(co); float v = l > 0.0 ? asin(clamp(co.z / l, -1.0, 1.0)) / (0.5 * PI) : 0.0; return vec2(u, v); }
  return co.xy;
}

// Blend a texture into a colour (Blender Internal texture-slot style). rec = texture record index.
vec3 applyTexture(vec3 base, int rec, vec3 orco, vec2 uv, bool hasUV) {
  vec4 t0 = fetch(uTexRec, rec * 7), t1 = fetch(uTexRec, rec * 7 + 1), t2 = fetch(uTexRec, rec * 7 + 2);
  vec4 t3 = fetch(uTexRec, rec * 7 + 3), t4 = fetch(uTexRec, rec * 7 + 4), t5 = fetch(uTexRec, rec * 7 + 5), t6 = fetch(uTexRec, rec * 7 + 6);
  int type = int(t0.x);
  int mapping = int(t0.z);
  bool useUV = t0.w > 0.5 && hasUV;
  vec3 co = useUV ? vec3(uv * 2.0 - 1.0, 0.0) : orco;
  co = (co + t1.xyz) * t2.xyz;
  float factor = t1.w;
  int blend = int(t2.w);
  vec3 col; float fac;
  if (type == 1) {
    vec2 st = (useUV ? co.xy : project(co, mapping)) * 0.5 + 0.5;
    vec4 c = textureLod(uImages, vec3(fract(st), t0.y), 0.0);
    col = c.rgb * t6.rgb; fac = c.a;
    float l = lum(col); col = max(mix(vec3(l), col, t6.w), 0.0);
    if (t5.w > 0.5) { fac = dot(c.rgb, vec3(0.35, 0.45, 0.2)) * c.a; col = t5.rgb; }
  } else {
    float ns = max(t3.x, 1e-4);
    int depth = int(t3.y);
    bool hard = t3.w > 0.5;
    float v = 0.0;
    bool rgb = false;
    vec3 rgbc = vec3(0.0);
    if (type == 2) v = turb(co / ns, depth, hard);
    else if (type == 3) {
      int prog = int(t4.z);
      float x = co.x, y = co.y;
      if (prog == 0) v = (1.0 + x) / 2.0;
      else if (prog == 1) { v = max(0.0, (1.0 + x) / 2.0); v *= v; }
      else if (prog == 2) { v = clamp((1.0 + x) / 2.0, 0.0, 1.0); v = v * v * (3.0 - 2.0 * v); }
      else if (prog == 3) v = (2.0 + x + y) / 4.0;
      else if (prog == 4) v = max(0.0, 1.0 - length(co));
      else if (prog == 5) { v = max(0.0, 1.0 - length(co)); v *= v; }
      else v = atan(y, x) / (2.0 * PI) + 0.5;
    } else if (type == 4) {
      int wt = int(t4.w);
      float n = t3.z * turb(co / ns, depth, hard) * 0.1;
      if (wt == 0) v = 0.5 + 0.5 * sin((co.x + co.y + co.z) * 10.0);
      else if (wt == 1) v = 0.5 + 0.5 * sin(length(co.xy) * 20.0);
      else if (wt == 2) v = 0.5 + 0.5 * sin((co.x + co.y + co.z) * 10.0 + n * 10.0);
      else v = 0.5 + 0.5 * sin(length(co.xy) * 20.0 + n * 10.0);
    } else if (type == 5) { float n = turb(co / ns, depth, hard); v = pow(0.5 + 0.5 * sin((co.x + t3.z * n) * 5.0), 0.5); }
    else if (type == 6) v = clamp(voronoiF1(co / ns), 0.0, 1.0);
    else if (type == 7) { vec3 p = co * t3.z; rgb = true; rgbc = vec3(0.5 + 0.5 * sin(p.x * 3.0 + p.y), 0.5 + 0.5 * cos(p.y * 3.0 - p.z), 0.5 + 0.5 * sin(p.z * 3.0 + p.x)); }
    else if (type == 8) { float n = turb(co / ns, 2, hard); v = smoothstep(0.45, 0.6, n); }
    else if (type == 9) v = fract(sin(dot(floor(co * 200.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    if (rgb) { col = rgbc * t6.rgb; fac = 1.0; }
    else { v = clamp((v - 0.5) * t4.y + 0.5, 0.0, 1.0) * t4.x; col = t5.rgb; fac = v; }
  }
  fac *= factor;
  if (blend == 1) return base + col * fac;
  if (blend == 2) return max(base - col * fac, 0.0);
  if (blend == 3) return base * mix(vec3(1.0), col, fac);
  if (blend == 4) return 1.0 - (1.0 - base) * (1.0 - col * fac);
  return mix(base, col, fac);
}

// ------------------------------------------------------------------ surfaces

struct Surf {
  vec3 P;       // position
  vec3 Ng;      // geometric normal, facing the incoming ray
  vec3 N;       // shading normal, facing the incoming ray
  bool front;   // the ray hit the outside (front face) of the triangle
  int mat;
  vec3 orco;
  vec2 uv;
  bool hasUV;
  vec3 vcol;
};

Surf surface(int ti, vec2 bc, vec3 ro, vec3 rd, float t) {
  Surf s;
  vec4 a = fetch(uTri, ti * 3);
  vec3 e1 = fetch(uTri, ti * 3 + 1).xyz, e2 = fetch(uTri, ti * 3 + 2).xyz;
  s.mat = int(a.w);
  s.P = ro + rd * t;
  vec3 ng = normalize(cross(e1, e2));
  s.front = dot(ng, rd) < 0.0;
  float w0 = 1.0 - bc.x - bc.y;
  int vb = ti * 9;
  vec4 c0 = fetch(uVtx, vb), c1 = fetch(uVtx, vb + 3), c2 = fetch(uVtx, vb + 6);
  vec3 n = c0.xyz * w0 + c1.xyz * bc.x + c2.xyz * bc.y;
  n = dot(n, n) > 1e-12 ? normalize(n) : ng;
  if (!s.front) { ng = -ng; n = -n; }
  // keep the shading normal on the visible side
  if (dot(n, -rd) <= 0.0) n = normalize(n + ng * (0.01 - dot(n, -rd)));
  s.Ng = ng;
  s.N = n;
  vec4 o0 = fetch(uVtx, vb + 1), o1 = fetch(uVtx, vb + 4), o2 = fetch(uVtx, vb + 7);
  s.orco = o0.xyz * w0 + o1.xyz * bc.x + o2.xyz * bc.y;
  vec2 uv0 = vec2(c0.w, o0.w), uv1 = vec2(c1.w, o1.w), uv2 = vec2(c2.w, o2.w);
  s.uv = uv0 * w0 + uv1 * bc.x + uv2 * bc.y;
  s.hasUV = dot(abs(uv0) + abs(uv1) + abs(uv2), vec2(1.0)) > 0.0;
  s.vcol = fetch(uVtx, vb + 2).rgb * w0 + fetch(uVtx, vb + 5).rgb * bc.x + fetch(uVtx, vb + 8).rgb * bc.y;
  return s;
}

// Material record: (leaf start, leaf count, total weight, emission texture), (emission rgb, -),
// (cumulative leaf probabilities), (leaf weight / probability)
vec3 materialEmission(Surf s) {
  vec4 m0 = fetch(uMat, s.mat * 4);
  vec3 e = fetch(uMat, s.mat * 4 + 1).rgb;
  if (m0.w >= 0.0 && max3(e) > 0.0) e *= applyTexture(vec3(1.0), int(m0.w), s.orco, s.uv, s.hasUV);
  return e;
}

#define K_PRINCIPLED 0
#define K_DIFFUSE 1
#define K_GLOSSY 2
#define K_GLASS 3
#define K_REFRACTION 4
#define K_TRANSLUCENT 5
#define K_TRANSPARENT 6

struct Bsdf {
  vec3 base;
  int kind;
  float metallic, spec, rough, trans, ior, tint;
  float weight;  // leaf weight / selection probability
};

// pick one leaf of the material (one-sample estimator of the shader mix); false if the material has no BSDF
bool pickLeaf(Surf s, float u, out Bsdf b) {
  vec4 m0 = fetch(uMat, s.mat * 4);
  int cnt = int(m0.y);
  if (cnt == 0) return false;
  vec4 cum = fetch(uMat, s.mat * 4 + 2), mult = fetch(uMat, s.mat * 4 + 3);
  int i = u < cum.x ? 0 : u < cum.y ? 1 : u < cum.z ? 2 : 3;
  i = min(i, cnt - 1);
  int li = int(m0.x) + i;
  vec4 l0 = fetch(uLeaf, li * 4), l1 = fetch(uLeaf, li * 4 + 1), l2 = fetch(uLeaf, li * 4 + 2);
  b.base = l0.rgb;
  b.kind = int(l0.w);
  b.metallic = l1.x; b.spec = l1.y; b.rough = l1.z; b.trans = l1.w;
  b.ior = l2.x; b.tint = l2.y;
  b.weight = i == 0 ? mult.x : i == 1 ? mult.y : i == 2 ? mult.z : mult.w;
  if (l2.z > 0.0) b.base = s.vcol * l2.z;
  if (l2.w >= 0.0) b.base = applyTexture(b.base, int(l2.w), s.orco, s.uv, s.hasUV);
  return true;
}

// transparency of a surface for shadow rays (sum over transparent leaves of weight x colour)
vec3 surfaceTransparency(int mat) {
  vec4 m0 = fetch(uMat, mat * 4);
  int cnt = int(m0.y);
  vec3 tr = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= cnt) break;
    int li = int(m0.x) + i;
    vec4 l0 = fetch(uLeaf, li * 4);
    if (int(l0.w) == K_TRANSPARENT) {
      vec4 cum = fetch(uMat, mat * 4 + 2);
      float p = (i == 0 ? cum.x : i == 1 ? cum.y - cum.x : i == 2 ? cum.z - cum.y : cum.w - cum.z) * m0.z;
      tr += l0.rgb * p;
    }
  }
  return tr;
}

// ------------------------------------------------------------------ microfacet helpers (GGX)

float ggxD(float nh, float a2) { float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float ggxG1(float nv, float a2) { nv = abs(nv); return 2.0 * nv / (nv + sqrt(a2 + (1.0 - a2) * nv * nv)); }
vec3 schlick(vec3 f0, float c) { float m = clamp(1.0 - c, 0.0, 1.0); float m2 = m * m; return f0 + (1.0 - f0) * (m2 * m2 * m); }
float fresnelDielectric(float cosi, float eta) {
  // eta = n_incident / n_transmitted
  float c = abs(cosi);
  float g2 = 1.0 / (eta * eta) - 1.0 + c * c;
  if (g2 < 0.0) return 1.0;
  float g = sqrt(g2);
  float A = (g - c) / (g + c);
  float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * A * A * (1.0 + B * B);
}

// sample a visible microfacet normal (GGX), in the frame of n
vec3 sampleGGXVNDF(vec3 n, vec3 wo, float alpha, vec2 u) {
  vec3 t, b; basis(n, t, b);
  vec3 v = vec3(dot(wo, t), dot(wo, b), dot(wo, n));
  vec3 vh = normalize(vec3(alpha * v.x, alpha * v.y, v.z));
  float lensq = vh.x * vh.x + vh.y * vh.y;
  vec3 T1 = lensq > 0.0 ? vec3(-vh.y, vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
  vec3 T2 = cross(vh, T1);
  float r = sqrt(u.x), phi = 2.0 * PI * u.y;
  float t1 = r * cos(phi), t2 = r * sin(phi);
  float sv = 0.5 * (1.0 + vh.z);
  t2 = (1.0 - sv) * sqrt(max(0.0, 1.0 - t1 * t1)) + sv * t2;
  vec3 nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * vh;
  vec3 m = normalize(vec3(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
  return normalize(t * m.x + b * m.y + n * m.z);
}

// lobe selection probabilities: diffuse, specular reflection, transmission (glass)
vec3 lobeProbs(Bsdf b, float nv) {
  if (b.kind == K_DIFFUSE || b.kind == K_TRANSLUCENT) return vec3(1.0, 0.0, 0.0);
  if (b.kind == K_GLOSSY) return vec3(0.0, 1.0, 0.0);
  if (b.kind == K_GLASS || b.kind == K_REFRACTION) return vec3(0.0, 0.0, 1.0);
  float wd = (1.0 - b.metallic) * (1.0 - b.trans) * max(lum(b.base), 0.02);
  vec3 f0 = mix(vec3(0.08 * b.spec), b.base, b.metallic);
  float ws = (1.0 - (1.0 - b.metallic) * b.trans) * max(lum(schlick(f0, nv)), b.spec > 0.0 || b.metallic > 0.0 ? 0.04 : 0.0);
  float wt = (1.0 - b.metallic) * b.trans;
  float sum = wd + ws + wt;
  return sum > 0.0 ? vec3(wd, ws, wt) / sum : vec3(1.0, 0.0, 0.0);
}

vec3 specF0(Bsdf b) {
  vec3 tintc = lum(b.base) > 0.0 ? b.base / lum(b.base) : vec3(1.0);
  vec3 dielectric = 0.08 * b.spec * mix(vec3(1.0), tintc, b.tint);
  return b.kind == K_GLOSSY ? b.base : mix(dielectric, b.base, b.metallic);
}

float alphaOf(float rough) { return max(rough * rough, 1e-4); }
bool isSharp(float rough) { return rough < 0.02; }

// Evaluate the non-singular lobes (diffuse, rough specular, translucent): returns f * |cos|, and the
// pdf of sampling wi with sampleBsdf's non-singular lobes (including the lobe selection probability).
vec3 evalBsdf(Bsdf b, Surf s, vec3 wo, vec3 wi, out float pdf) {
  pdf = 0.0;
  vec3 N = s.N;
  float nl = dot(N, wi), nv = max(dot(N, wo), 1e-4);
  bool above = dot(s.Ng, wi) > 0.0;
  vec3 pr = lobeProbs(b, nv);
  vec3 f = vec3(0.0);
  if (b.kind == K_TRANSLUCENT) {
    if (!above && nl < 0.0) { f = b.base * INV_PI * (-nl); pdf = -nl * INV_PI; }
    return f;
  }
  if (!above || nl <= 0.0) return f;
  if (pr.x > 0.0) {
    f += b.base * (1.0 - b.metallic) * (1.0 - b.trans) * INV_PI * nl;
    pdf += pr.x * nl * INV_PI;
  }
  if (pr.y > 0.0 && !isSharp(b.rough)) {
    float a = alphaOf(b.rough), a2 = a * a;
    vec3 h = normalize(wo + wi);
    float nh = max(dot(N, h), 0.0), vh = max(dot(wo, h), 0.0);
    float D = ggxD(nh, a2);
    float G1v = ggxG1(nv, a2), G1l = ggxG1(nl, a2);
    vec3 F = schlick(specF0(b), vh);
    float scale = b.kind == K_PRINCIPLED ? 1.0 - (1.0 - b.metallic) * b.trans : 1.0;
    f += F * (D * G1v * G1l / (4.0 * nv)) * scale;
    pdf += pr.y * G1v * D / (4.0 * nv);
  }
  return f;
}

// Sample a direction. weight = f * |cos| / pdf (times the leaf weight, applied by the caller).
// singular: the direction came from a delta-like lobe (mirror, glass) that light sampling cannot reach.
// lobe: 0 diffuse, 1 glossy, 2 transmission.
bool sampleBsdf(Bsdf b, Surf s, vec3 wo, out vec3 wi, out vec3 weight, out float pdf, out bool singular, out int lobe) {
  vec3 N = s.N;
  float nv = max(dot(N, wo), 1e-4);
  vec3 pr = lobeProbs(b, nv);
  float u = rnd();
  vec2 u2 = rnd2();
  singular = false;
  pdf = 0.0;
  weight = vec3(0.0);
  lobe = 0;
  if (u < pr.x) {
    lobe = 0;
    if (b.kind == K_TRANSLUCENT) {
      wi = cosineSample(-N, u2);
      if (dot(s.Ng, wi) >= 0.0) return false;
    } else {
      wi = cosineSample(N, u2);
      if (dot(s.Ng, wi) <= 0.0) return false;
    }
  } else if (u < pr.x + pr.y) {
    lobe = 1;
    if (isSharp(b.rough)) {
      wi = reflect(-wo, N);
      if (dot(s.Ng, wi) <= 0.0) return false;
      float scale = b.kind == K_PRINCIPLED ? 1.0 - (1.0 - b.metallic) * b.trans : 1.0;
      weight = schlick(specF0(b), nv) * scale / pr.y;
      // the diffuse lobe still contributes along the mirror direction only with zero measure: ignore
      singular = true;
      pdf = 0.0;
      return true;
    }
    vec3 h = sampleGGXVNDF(N, wo, alphaOf(b.rough), u2);
    wi = reflect(-wo, h);
    if (dot(s.Ng, wi) <= 0.0 || dot(N, wi) <= 0.0) return false;
  } else {
    // glass / refraction (smooth or rough), treated as a singular lobe
    lobe = 2;
    singular = true;
    float eta = s.front ? 1.0 / b.ior : b.ior;
    vec3 m = isSharp(b.rough) ? N : sampleGGXVNDF(N, wo, alphaOf(b.rough), u2);
    float c = dot(wo, m);
    float F = b.kind == K_REFRACTION ? 0.0 : fresnelDielectric(c, eta);
    vec3 tintR = b.kind == K_GLASS ? b.base : vec3(1.0);
    vec3 refr = refract(-wo, m, eta);
    if (dot(refr, refr) == 0.0) F = 1.0;
    if (rnd() < F) {
      wi = reflect(-wo, m);
      if (dot(s.Ng, wi) <= 0.0) return false;
      weight = tintR / pr.z;
      lobe = 1;
    } else {
      wi = normalize(refr);
      if (dot(s.Ng, wi) >= 0.0) return false;
      weight = b.base / pr.z;
    }
    if (!isSharp(b.rough)) weight *= ggxG1(dot(N, wi), alphaOf(b.rough) * alphaOf(b.rough));
    return true;
  }
  vec3 f = evalBsdf(b, s, wo, wi, pdf);
  if (pdf <= 0.0) return false;
  weight = f / pdf;
  return true;
}

// ------------------------------------------------------------------ lights

// Light record (5 texels): (pos, type), (dir, radius/angle), (emission, spot cos), (u, spot blend), (v, flags)
#define L_POINT 0
#define L_SUN 1
#define L_SPOT 2
#define L_AREA 3

float spotMask(vec4 l2, vec4 l3, vec3 lampDir, vec3 toPoint) {
  if (l2.w < -1.5) return 1.0;
  float c = dot(lampDir, toPoint);
  float cosHalf = l2.w;
  if (c <= cosHalf) return 0.0;
  float smoothw = (1.0 - cosHalf) * l3.w;
  return smoothw > 0.0 ? smoothstep(0.0, smoothw, c - cosHalf) : 1.0;
}

vec3 background(vec3 d) {
  if (uWorldMode == 0) return uHorizon * uWorldStrength;
  float t = clamp(abs(d.z), 0.0, 1.0);
  return mix(uHorizon, uZenith, t) * uWorldStrength;
}

struct LightSample {
  vec3 wi;
  float dist;
  vec3 Li;      // incoming radiance (or irradiance for singular lights)
  float pdf;    // solid angle pdf incl. selection probability (selection probability only for singular lights)
  bool singular;
  bool shadow;  // cast shadows
  bool mis;
  int maxBounce;
};

bool sampleLamp(int i, vec3 P, float sel, out LightSample ls) {
  vec4 l0 = fetch(uLights, i * 5), l1 = fetch(uLights, i * 5 + 1), l2 = fetch(uLights, i * 5 + 2);
  vec4 l3 = fetch(uLights, i * 5 + 3), l4 = fetch(uLights, i * 5 + 4);
  int type = int(l0.w);
  int flags = int(l4.w);
  ls.shadow = (flags & 1) != 0;
  ls.mis = (flags & 2) != 0;
  ls.maxBounce = flags >> 2;
  ls.singular = false;
  vec2 u = rnd2();
  if (type == L_SUN) {
    vec3 toSun = -normalize(l1.xyz);
    float ang = l1.w;
    ls.dist = 1e30;
    if (ang <= 1e-4) {
      ls.wi = toSun; ls.Li = l2.rgb; ls.pdf = sel; ls.singular = true;
    } else {
      float cosMax = cos(ang);
      ls.wi = coneSample(toSun, cosMax, u);
      float sa = 2.0 * PI * (1.0 - cosMax);
      ls.Li = l2.rgb / (PI * sin(ang) * sin(ang));
      ls.pdf = sel / sa;
    }
    return true;
  }
  if (type == L_AREA) {
    vec3 q = l0.xyz + l3.xyz * (2.0 * u.x - 1.0) + l4.xyz * (2.0 * u.y - 1.0);
    vec3 d = q - P;
    float d2 = dot(d, d);
    if (d2 < 1e-12) return false;
    ls.dist = sqrt(d2);
    ls.wi = d / ls.dist;
    vec3 n = normalize(l1.xyz);
    float cosL = dot(-ls.wi, n);
    if (cosL <= 1e-6) return false;
    float area = 4.0 * length(l3.xyz) * length(l4.xyz);
    ls.Li = l2.rgb;
    ls.pdf = sel * d2 / (cosL * area);
    return true;
  }
  // point / spot
  vec3 c = l0.xyz;
  vec3 d = c - P;
  float d2 = dot(d, d);
  if (d2 < 1e-12) return false;
  float dist = sqrt(d2);
  vec3 toL = d / dist;
  float mask = spotMask(l2, l3, normalize(l1.xyz), -toL);
  if (mask <= 0.0) return false;
  float r = l1.w;
  if (r <= 1e-5 || r >= dist) {
    ls.wi = toL; ls.dist = dist; ls.Li = l2.rgb * mask / d2; ls.pdf = sel; ls.singular = true;
    return true;
  }
  float sinMax2 = r * r / d2;
  float cosMax = sqrt(max(0.0, 1.0 - sinMax2));
  ls.wi = coneSample(toL, cosMax, u);
  // distance to the sphere surface along wi
  float b = dot(ls.wi, d);
  float disc = b * b - d2 + r * r;
  ls.dist = b - sqrt(max(0.0, disc));
  ls.Li = l2.rgb * mask / (PI * r * r);
  ls.pdf = sel / (2.0 * PI * (1.0 - cosMax));
  return true;
}

// sample a point on an emissive triangle
bool sampleEmitter(vec3 P, out LightSample ls) {
  float r = rnd();
  int lo = 0, hi = uEmitCount - 1;
  for (int k = 0; k < 24; k++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    if (fetch(uEmit, mid).y < r) lo = mid + 1; else hi = mid;
  }
  int ti = int(fetch(uEmit, lo).x);
  vec2 u = rnd2();
  float su = sqrt(u.x);
  vec2 bc = vec2(su * (1.0 - u.y), su * u.y);
  vec4 a = fetch(uTri, ti * 3);
  vec3 e1 = fetch(uTri, ti * 3 + 1).xyz, e2 = fetch(uTri, ti * 3 + 2).xyz;
  vec3 q = a.xyz + e1 * bc.x + e2 * bc.y;
  vec3 d = q - P;
  float d2 = dot(d, d);
  if (d2 < 1e-12) return false;
  ls.dist = sqrt(d2);
  ls.wi = d / ls.dist;
  vec3 n = normalize(cross(e1, e2));
  float cosL = abs(dot(n, ls.wi));
  if (cosL < 1e-6) return false;
  Surf es = surface(ti, bc, P, ls.wi, ls.dist);
  ls.Li = materialEmission(es);
  float lumE = lum(fetch(uMat, es.mat * 4 + 1).rgb);
  ls.pdf = uMeshLightProb * lumE * d2 / (cosL * uEmitTotal);
  ls.singular = false;
  ls.shadow = true;
  ls.mis = true;
  ls.maxBounce = 1024;
  ls.dist *= 0.9999;
  return ls.pdf > 0.0;
}

bool sampleLight(vec3 P, out LightSample ls) {
  float r = rnd();
  if (r < uMeshLightProb) return sampleEmitter(P, ls);
  if (uLightCount == 0) return false;
  float sel = (1.0 - uMeshLightProb) / float(uLightCount);
  int i = min(int(rnd() * float(uLightCount)), uLightCount - 1);
  return sampleLamp(i, P, sel, ls);
}

// emission of lamps hit by a BSDF-sampled ray (for multiple importance sampling)
vec3 lampHits(vec3 ro, vec3 rd, float tmax, float bsdfPdf, bool singular, int bounce) {
  vec3 sum = vec3(0.0);
  float sel = (1.0 - uMeshLightProb) / float(max(uLightCount, 1));
  for (int i = 0; i < 64; i++) {
    if (i >= uLightCount) break;
    vec4 l0 = fetch(uLights, i * 5), l1 = fetch(uLights, i * 5 + 1);
    int type = int(l0.w);
    vec4 l4 = fetch(uLights, i * 5 + 4);
    int flags = int(l4.w);
    if ((flags & 2) == 0 || bounce - 1 > (flags >> 2)) continue;
    vec4 l2 = fetch(uLights, i * 5 + 2);
    float lpdf = 0.0;
    vec3 L = vec3(0.0);
    if (type == L_SUN) {
      float ang = l1.w;
      if (ang <= 1e-4 || tmax < 1e29) continue;
      float cosMax = cos(ang);
      if (dot(rd, -normalize(l1.xyz)) < cosMax) continue;
      L = l2.rgb / (PI * sin(ang) * sin(ang));
      lpdf = sel / (2.0 * PI * (1.0 - cosMax));
    } else if (type == L_AREA) {
      vec4 l3 = fetch(uLights, i * 5 + 3);
      vec3 n = normalize(l1.xyz);
      float dn = dot(rd, n);
      if (dn >= -1e-6) continue;
      float t = dot(l0.xyz - ro, n) / dn;
      if (t <= 0.0 || t >= tmax) continue;
      vec3 q = ro + rd * t - l0.xyz;
      vec3 uu = l3.xyz, vv = l4.xyz;
      float lu = dot(q, uu) / dot(uu, uu), lv = dot(q, vv) / dot(vv, vv);
      if (abs(lu) > 1.0 || abs(lv) > 1.0) continue;
      float area = 4.0 * length(uu) * length(vv);
      L = l2.rgb;
      lpdf = sel * t * t / (-dn * area);
    } else {
      float r = l1.w;
      if (r <= 1e-5) continue;
      vec3 d = l0.xyz - ro;
      float d2 = dot(d, d);
      if (d2 <= r * r) continue;
      float b = dot(rd, d);
      float disc = b * b - d2 + r * r;
      if (disc < 0.0) continue;
      float t = b - sqrt(disc);
      if (t <= 0.0 || t >= tmax) continue;
      vec4 l3 = fetch(uLights, i * 5 + 3);
      float mask = spotMask(l2, l3, normalize(l1.xyz), normalize(ro - l0.xyz));
      if (mask <= 0.0) continue;
      L = l2.rgb * mask / (PI * r * r);
      float cosMax = sqrt(max(0.0, 1.0 - r * r / d2));
      lpdf = sel / (2.0 * PI * (1.0 - cosMax));
    }
    float w = singular ? 1.0 : (bsdfPdf * bsdfPdf) / (bsdfPdf * bsdfPdf + lpdf * lpdf);
    sum += L * w;
  }
  return sum;
}

// shadow ray towards a light, through transparent surfaces when enabled; returns the transmittance
vec3 shadowRay(vec3 ro, vec3 rd, float tmax) {
  if (uHasTransparent == 0 || uTransparentShadows == 0) return occludedAny(ro, rd, tmax) ? vec3(0.0) : vec3(1.0);
  vec3 tr = vec3(1.0);
  for (int i = 0; i < 16; i++) {
    if (i > uTranspMax) return vec3(0.0);
    float t; vec2 bc;
    int ti = traceClosest(ro, rd, tmax, t, bc);
    if (ti < 0) return tr;
    int mat = int(fetch(uTri, ti * 3).w);
    vec3 st = surfaceTransparency(mat);
    tr *= st;
    if (max3(tr) <= 1e-4) return vec3(0.0);
    ro = ro + rd * (t + uEps);
    tmax -= t + uEps;
    if (tmax <= 0.0) return tr;
  }
  return vec3(0.0);
}

vec3 clampC(vec3 c, float m) {
  if (m <= 0.0) return c;
  float mx = max3(c);
  return mx > m ? c * (m / mx) : c;
}

float gauss(float u1, float u2, float sigma) {
  return sigma * sqrt(-2.0 * log(max(u1, 1e-7))) * cos(2.0 * PI * u2);
}

// ------------------------------------------------------------------ main

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  rngState = pcgHash(uint(pix.x) + pcgHash(uint(pix.y) + pcgHash(uint(uSample) + pcgHash(uint(uSeed) + 1013904223u))));

  // pixel filter (importance sampled: every sample has weight 1)
  vec2 off;
  vec2 u0 = rnd2();
  if (uFilterType == 0) off = (u0 - 0.5) * uFilterWidth;
  else {
    float sigma = uFilterType == 1 ? uFilterWidth / 6.0 : uFilterWidth / 3.0;
    float lim = uFilterType == 1 ? uFilterWidth * 0.5 : uFilterWidth;
    float g1 = gauss(u0.x, u0.y, sigma), g2 = gauss(rnd(), rnd(), sigma);
    off = clamp(vec2(g1, g2), -lim, lim);
  }
  vec2 ndc = (gl_FragCoord.xy + off) / uRes * 2.0 - 1.0;
  vec4 pn = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 pf = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = pn.xyz / pn.w;
  vec3 rfar = pf.xyz / pf.w;
  vec3 rd = normalize(rfar - ro);
  float tmax = length(rfar - ro);

  vec3 L = vec3(0.0);
  vec3 thr = vec3(1.0);
  float alpha = 1.0;
  bool cameraRay = true;   // still on the camera path (only transparent surfaces passed)
  bool singular = true;    // last bounce was singular (or the camera)
  float lastPdf = 0.0;
  int bounce = 0, nDiffuse = 0, nGlossy = 0, nTrans = 0, nTransp = 0;
  bool hadDiffuse = false;
  vec3 albedo = vec3(0.0), normal = vec3(0.0);
  bool gotFeatures = false;

  for (int iter = 0; iter < 96; iter++) {
    float t; vec2 bc;
    int ti = traceClosest(ro, rd, tmax, t, bc);
    if (ti < 0) {
      // lamps with a size can be hit by BSDF rays
      if (!cameraRay && uLightCount > 0) L += clampC(thr * lampHits(ro, rd, 1e30, lastPdf, singular, bounce), bounce <= 1 ? uClampDirect : uClampIndirect);
      vec3 bg = background(rd);
      if (cameraRay) {
        // seen through nothing but transparent surfaces: the background (transparent with Film > Transparent)
        if (uFilmTransparent == 1) alpha = nTransp > 0 ? 1.0 - clamp(lum(thr), 0.0, 1.0) : 0.0;
        else if (uWorldVisible == 1) L += thr * bg;
        if (!gotFeatures) { albedo = bg; gotFeatures = true; }
      } else {
        L += clampC(thr * bg, bounce <= 1 ? uClampDirect : uClampIndirect);
      }
      break;
    }
    if (!cameraRay && uLightCount > 0) L += clampC(thr * lampHits(ro, rd, t, lastPdf, singular, bounce), bounce <= 1 ? uClampDirect : uClampIndirect);
    Surf s = surface(ti, bc, ro, rd, t);
    vec3 wo = -rd;

    // emission
    vec3 Le = materialEmission(s);
    if (max3(Le) > 0.0) {
      float w = 1.0;
      if (!singular) {
        float cosL = abs(dot(s.Ng, rd));
        vec4 m1 = fetch(uMat, s.mat * 4 + 1);
        float lpdf = uEmitCount > 0 && m1.w > 0.5 ? uMeshLightProb * lum(m1.rgb) * t * t / (max(cosL, 1e-6) * uEmitTotal) : 0.0;
        w = lastPdf * lastPdf / (lastPdf * lastPdf + lpdf * lpdf);
      }
      L += clampC(thr * Le * w, bounce == 0 ? 1e30 : bounce == 1 ? uClampDirect : uClampIndirect);
    }

    Bsdf b;
    if (!pickLeaf(s, rnd(), b)) {
      if (!gotFeatures) { albedo = Le; normal = s.N; gotFeatures = true; }
      break;
    }
    if (b.kind == K_TRANSPARENT) {
      thr *= b.base * b.weight;
      nTransp++;
      if (nTransp > uTranspMax || max3(thr) <= 0.0) { if (cameraRay && uFilmTransparent == 1) alpha = 1.0; break; }
      if (nTransp > uTranspMin) {
        float q = min(max3(thr), 1.0);
        if (rnd() >= q) break;
        thr /= q;
      }
      ro = s.P + rd * uEps;
      tmax = 1e30;
      continue;
    }
    if (cameraRay) { cameraRay = false; alpha = 1.0; }
    if (!gotFeatures) { albedo = b.base; normal = s.N; gotFeatures = true; }

    // filter glossy / no caustics after a diffuse bounce
    if (hadDiffuse && uBlurGlossy > 0.0) b.rough = max(b.rough, min(1.0, uBlurGlossy * 0.5));

    vec3 Pofs = s.P + s.Ng * uEps;
    float nv = max(dot(s.N, wo), 1e-4);
    vec3 pr = lobeProbs(b, nv);

    // next-event estimation (one light sample)
    if ((uLightCount > 0 || uEmitCount > 0) && (pr.x > 0.0 || (pr.y > 0.0 && !isSharp(b.rough)))) {
      LightSample ls;
      if (sampleLight(s.P, ls) && bounce <= ls.maxBounce && ls.pdf > 0.0) {
        float bpdf;
        vec3 f = evalBsdf(b, s, wo, ls.wi, bpdf);
        if (max3(f) > 0.0) {
          vec3 org = dot(ls.wi, s.Ng) >= 0.0 ? Pofs : s.P - s.Ng * uEps;
          vec3 vis = ls.shadow ? shadowRay(org, ls.wi, ls.dist - 2.0 * uEps) : vec3(1.0);
          if (max3(vis) > 0.0) {
            float w = (ls.singular || !ls.mis) ? 1.0 : (ls.pdf * ls.pdf) / (ls.pdf * ls.pdf + bpdf * bpdf);
            L += clampC(thr * b.weight * f * ls.Li * vis * (w / ls.pdf), bounce == 0 ? uClampDirect : uClampIndirect);
          }
        }
      }
    }
    // world ambient occlusion
    if (uUseAO == 1 && pr.x > 0.0 && b.kind != K_TRANSLUCENT) {
      vec3 d = cosineSample(s.N, rnd2());
      if (dot(d, s.Ng) > 0.0 && !occludedAny(Pofs, d, uAODist)) {
        L += clampC(thr * b.weight * b.base * (1.0 - b.metallic) * (1.0 - b.trans) * uAOFactor, bounce == 0 ? uClampDirect : uClampIndirect);
      }
    }

    // continue the path
    vec3 wi, weight; float pdf; bool sing; int lobe;
    if (!sampleBsdf(b, s, wo, wi, weight, pdf, sing, lobe)) break;
    if (hadDiffuse && ((lobe == 1 && uCausticsRefl == 0) || (lobe == 2 && uCausticsRefr == 0))) break;
    bounce++;
    if (bounce > uMaxBounces) break;
    if (lobe == 0) { nDiffuse++; hadDiffuse = true; if (nDiffuse > uDiffuseBounces) break; }
    else if (lobe == 1) { nGlossy++; if (nGlossy > uGlossyBounces) break; }
    else { nTrans++; if (nTrans > uTransBounces) break; }
    thr *= weight * b.weight;
    if (max3(thr) <= 0.0) break;
    if (bounce >= uMinBounces) {
      float q = min(max3(thr), 1.0);
      if (rnd() >= q) break;
      thr /= q;
    }
    singular = sing;
    lastPdf = pdf;
    ro = dot(wi, s.Ng) >= 0.0 ? Pofs : s.P - s.Ng * uEps;
    rd = wi;
    tmax = 1e30;
  }

  if (uFilmTransparent == 0) alpha = 1.0;
  if (any(isnan(L)) || any(isinf(L))) L = vec3(0.0);
  vec4 prevC = texelFetch(uPrevColor, pix, 0);
  vec4 prevA = texelFetch(uPrevAlbedo, pix, 0);
  vec4 prevN = texelFetch(uPrevNormal, pix, 0);
  oColor = mix(prevC, vec4(L, alpha), uBlend);
  oAlbedo = mix(prevA, vec4(albedo, 1.0), uBlend);
  oNormal = mix(prevN, vec4(normal, 1.0), uBlend);
}
`;

/** Exposure, clipping, the sRGB view transform and dithering; output is premultiplied RGBA. */
export const DISPLAY = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform float uExposure;
uniform float uDither;
uniform int uOpaque;
in vec2 vUv;
out vec4 o;
float toSRGB(float c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(uColor, vUv);
  float a = uOpaque == 1 ? 1.0 : clamp(c.a, 0.0, 1.0);
  vec3 rgb = max(c.rgb * uExposure, 0.0);
  // the colour is premultiplied by coverage: un-premultiply for the view transform
  if (a > 0.0 && uOpaque == 0) rgb /= a;
  rgb = clamp(rgb, 0.0, 1.0);
  rgb = vec3(toSRGB(rgb.r), toSRGB(rgb.g), toSRGB(rgb.b));
  rgb += (hash(gl_FragCoord.xy) - 0.5) * uDither / 255.0;
  o = vec4(clamp(rgb, 0.0, 1.0) * a, a);
}
`;

/**
 * One pass of an edge-avoiding a-trous wavelet filter on the illumination (colour / albedo),
 * guided by the accumulated albedo and normal passes.
 */
export const DENOISE = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor, uAlbedo, uNormal;
uniform int uStep;
uniform float uSigmaColor, uSigmaNormal, uSigmaAlbedo;
uniform int uFirst, uLast;
in vec2 vUv;
out vec4 o;
vec3 demod(vec3 c, vec3 a) { return c / max(a, vec3(0.02)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uColor, 0);
  vec4 c0 = texelFetch(uColor, p, 0);
  vec3 a0 = texelFetch(uAlbedo, p, 0).rgb;
  vec3 n0 = texelFetch(uNormal, p, 0).xyz;
  vec3 i0 = uFirst == 1 ? demod(c0.rgb, a0) : c0.rgb;
  float k[3] = float[3](0.375, 0.25, 0.0625);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
    ivec2 q = clamp(p + ivec2(dx, dy) * uStep, ivec2(0), size - 1);
    vec4 c = texelFetch(uColor, q, 0);
    vec3 a = texelFetch(uAlbedo, q, 0).rgb;
    vec3 n = texelFetch(uNormal, q, 0).xyz;
    vec3 il = uFirst == 1 ? demod(c.rgb, a) : c.rgb;
    float w = k[abs(dx)] * k[abs(dy)];
    vec3 dc = il - i0;
    w *= exp(-dot(dc, dc) / (uSigmaColor * float(uStep) + 1e-6));
    vec3 dn = n - n0;
    w *= exp(-dot(dn, dn) / uSigmaNormal);
    vec3 da = a - a0;
    w *= exp(-dot(da, da) / uSigmaAlbedo);
    sum += il * w;
    wsum += w;
  }
  vec3 r = sum / max(wsum, 1e-6);
  if (uLast == 1) r *= max(a0, vec3(0.02));
  o = vec4(r, c0.a);
}
`;
