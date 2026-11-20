#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uSampleIndex;
uniform int uSpp;
uniform float uTime;
uniform float uShutterSec;
uniform float uLoop;
uniform float uSpeed;
uniform float uNoiseW;

uniform vec3 uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uFov;

uniform float uIOR;
uniform vec3 uTint;
uniform float uDensity;
uniform vec3 uEmissive;
uniform float uEmissiveStr;

uniform int uBlobs;
uniform float uVolume;
uniform float uBlend;
uniform float uSpread;
uniform float uNoiseAmp;
uniform float uNoiseScale;
uniform int uSeed;
uniform float uBound;

uniform float uEnvInt;
uniform vec3  uBg;
uniform int   uBounces;
uniform float uClamp;
uniform float uFurnace;

out vec4 fragColor;

//---------RNG----------
uint rngState;
uint pcg(uint v) 
{
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> (( s >> 28u) + 4u)) ^s) * 277803737u;
    return (w >> 22u) ^ w;
}
float rnd()
{
    rngState = pcg(rngState);
    return float(rngState) * (1.0 / 4294967296.0);
}

// ---------- Fluid SDF ----------
const int MAXB = 32;
vec4 gBlobs[MAXB];
float gT;

float smin(float a, float b, float k) 
{
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

void buildBlobs(float t) 
{
    gT = t;
    for (int i = 0; i < MAXB; i++) 
    {
        if (i >= uBlobs) break;
        uint n = uint(i) + uint(uSeed) * 977u;
        vec3 h = vec3(float(pcg(n * 3u + 1u)), float(pcg(n * 3u + 2u)), float(pcg(n * 3u + 3u))) * (1.0 / 4294967296.0);

        // Seamless loop: integer number of cycles per loop. Otherwise free-running, slowed by viscosity.
        vec3 w = uLoop > 0.0 ? (6.2831853 / uLoop) * floor(1.0 + h * 2.999) : (0.3 + 0.5 * h) * uSpeed;
        vec3 ph = 6.2831853 * fract(h.zxy * 7.31 + h.yzx * 3.17);
        vec3 pos = uSpread * vec3(sin(t * w.x + ph.x), 0.75 * sin(t * w.y + ph.y), cos(t * w.z + ph.z));
        float s = fract(h.x * 13.7 + h.y * 5.3);
        float r = uVolume * mix(0.10, 0.55, s * s);
        gBlobs[i] = vec4(pos, r);
    }
}

float map(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < MAXB; i++) 
    {
        if (i >= uBlobs) break;
        vec4 b = gBlobs[i];
        float s = length(p - b.xyz) - b.w;
        d = (i == 0) ? s : smin(d, s, uBlend);
    }
  if (uNoiseAmp > 0.0) 
    {
        vec3 q = p * uNoiseScale;
        d += uNoiseAmp * sin(q.x + gT * uNoiseW) * sin(q.y * 1.31 - gT * uNoiseW * 2.0) * sin(q.z * 0.87 + gT * uNoiseW);
    }
  return d;
}

vec3 calcNormal(vec3 p) 
{
    const vec2 k = vec2(1.0, -1.0);
    const float e = 0.0012;
    return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                     k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// Studio environment
vec3 env(vec3 d) 
{
    if (uFurnace > 0.5) return vec3(1.0);

    //broad, dim dome so every path has a chance of finding light --> less grain
    vec3 c = vec3(0.03, 0.035, 0.042) * (0.5 + 0.5 * d.y);
    float phi = atan(d.z, d.x);

    // large key softbox, top-left
    c += vec3(0.92, 0.97, 1.0) * 4.5 * smoothstep(0.62, 0.78, dot(d, normalize(vec3(-0.45, 0.75, 0.5))));

    //tall strip lightm right
    float strip = smoothstep(0.30, 0.12, abs(phi - 0.35)) * smoothstep(0.80, 0.50, abs(d.y - 0.05));
    c += vec3(1.0, 0.98, 0.95) * 5.0 * strip;

    //cool rim from behind
    c += vec3(0.55, 0.8, 1.0) * 3.5 * smoothstep(0.70, 0.88, dot(d, normalize(vec3(0.2, 0.3, -1.0))));

    //dim floor bounce
    c += vec3(0.05, 0.06, 0.07) * smoothstep(-0.2, -0.9, d.y);
    return c * uEnvInt;
}

float fresnelDielectric(float cosi, float eta) 
{ 
    // eta = n1 / n2
    float sint2 = eta * eta * (1.0 - cosi * cosi);
    if (sint2 >= 1.0) return 1.0;
    float cost = sqrt(1.0 - sint2);
    float rs = (eta * cosi - cost) / (eta * cosi + cost);
    float rp = (cosi - eta * cost) / (cosi + eta * cost);
    return 0.5 * (rs * rs + rp * rp);

}

// Path tracer 

vec3 trace(vec3 ro, vec3 rd)
{
    vec3 L = vec3(0.0), T = vec3(1.0);
    bool inside = false;
    bool furnace = uFurnace > 0.5;
    vec3 sigma = furnace ? vec3(0.0) : -log(clamp(uTint, vec3(0.001), vec3(1.0))) * uDensity;
    vec3 em = furnace ? vec3(0.0) : uEmissive * uEmissiveStr;

    for (int b = 0; b < 64; b++)
    {
        if (b >= uBounces) break;

        // Bounding sphere keeps empty-space rays cheap
        float bd = dot(ro, rd);
        float disc = bd * bd - (dot(ro, ro) - uBound * uBound);
        bool hit = false;
        float t = 0.0;
        if (disc > 0.0)
        {
            float sq = sqrt(disc);
            float t1 = -bd + sq;
            if (t1 > 0.0)
            {
                t = max(-bd - sq, 0.0);
                float sgn = inside ? -1.0 : 1.0;
                for (int i = 0; i < 200; i++)
                {
                    float d = sgn * map(ro + rd * t);
                    if (d < 0.0006 * (1.0 + t * 0.15))
                    {
                        hit = true;
                        break;
                    }
                    t += d * 0.8;
                    if (t > t1) break;
                }
            }
        }
        if (inside)
        {
            float dist = hit ? t : 0.0;
            vec3 Tr = exp(-sigma * dist);
            
            // Volume emission integrated analytically through absorbing medium
            vec3 ints = mix(vec3(dist), (1.0 - Tr) / max(sigma, vec3(1e-5)), step(vec3(1e-4), sigma));
            L += T * em * ints;
            T *= Tr;
            if (!hit) break;
        } 
        else if (!hit) 
        {
            L += T * (b == 0 ? (furnace ? vec3(1.0) : uBg) : env(rd));
            break;
        }
        
        vec3 p = ro + rd * t;
        vec3 n = calcNormal(p);
        if (dot(n, rd) > 0.0) n = -n; //face against the ray
        float eta = inside ? uIOR : 1.0 / uIOR;
        float F = fresnelDielectric(clamp(dot(-rd, n), 0.0, 1.0), eta);
        vec3 rf = refract(rd, n, eta);

        if (rnd() < F || dot(rf, rf) < 0.5)
        {
            rd = reflect(rd, n);
            ro = p + n * 0.003;
        }
        else 
        {
            rd = normalize(rf);
            ro = p - n * 0.003;
            inside = !inside;
        }
    }
    return L;
}

void main()
{
    uvec2 px = uvec2(gl_FragCoord.xy);
    rngState = pcg(px.x + pcg(px.y + pcg(uint(uSampleIndex) * 9781u + 1u)));

    vec3 acc = vec3(0.0);
    float aspect = uRes.x / uRes.y;
    float tf = tan(radians(uFov) * 0.5);
    for (int s = 0; s < 64; s++)
    {
        if (s >= uSpp) break;
        rngState = pcg(rngState + uint(s));
        buildBlobs(uTime + (rnd() - 0.5) * uShutterSec); // per sample time = motion blur

        vec2 uv = (gl_FragCoord.xy + vec2(rnd(), rnd())) / uRes * 2.0 - 1.0;
        uv.x *= aspect;
        vec3 rd = normalize(uCamFwd + uv.x * tf * uCamRight + uv.y * tf * uCamUp);
        vec3 c = trace(uCamPos, rd);
        if (any(isnan(c)) || any(isinf(c)))
        {
            c = vec3(0.0);
        }
        acc += min(c, vec3(uClamp));
    }

    vec3 prev = uSampleIndex > 0.5 ? texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rgb : vec3(0.0);
    float n = uSampleIndex;
    fragColor = vec4((prev * n + acc) / (n + float(uSpp)), 1.0);
}


