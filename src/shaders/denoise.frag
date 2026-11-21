#version 300 es
precision highp float;
precision highp sampler2D;

//Edge-avoiding a-trous wavelet denoiser (Dammertz et al. 2010) with SVGF-style noise estimate
// Run several times with uStep = 1,2, 4, 8, 16: each pass blurs over a wider area

uniform sampler2D uColor; // image to filter (previous pass or raw render)
uniform sampler2D uGuide; //first hit normal (xyz) + distance (w)
uniform sampler2D uMoments; // raw render: rgb = mean colour, a = mean luminance

uniform int uStep; // gap between 5x5 taps, as pixels 

uniform float uSamples; // samplers per pixel so far
uniform float uStrength; //how many noise levels of colour difference still count as "same"

out vec4 fragColor;

const float KERNEL[3] = float[3](0.375, 0.25, 0.0625); // B3 spline weights for offsets 0 1 2

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main()
{
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 size = textureSize(uColor, 0);

    vec3 cP = texelFetch(uColor, p, 0).rgb;
    vec4 gP = texelFetch(uGuide, p, 0);

    // Noise level. One sample's variance is E[l²] - E[l]², and averaging N samples divides it by N.
    // Measured over the 3x3 neighbourhood: one pixel alone can't see its noise at low sample counts,
    // and a dark pixel next to a firefly needs to know the area is noisy too.

    float m1 = 0.0;
    float m2 = 0.0;
    for (int y = -1; y <= 1; y++)
    {
        for (int x = -1; x <= 1; x++)
        {
            vec4 m = texelFetch(uMoments, clamp(p + ivec2(x, y), ivec2(0), size - 1), 0);
            m1 += lum(m.rgb);
            m2 += m.a;
        }
    }

    m1 /= 9.0;
    m2 /= 9.0;

    float variance = max(m2 - m1 * m1, 0.0) / max(uSamples, 1.0);
    float sigmaL = uStrength * sqrt(variance) + 1e-4;
    float lenP = length(gP.xyz);

    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int y = -2; y <= 2; y++)
    {
        for (int x = -2; x <= 2; x++)
        {
            ivec2 q = clamp(p + ivec2(x, y) * uStep, ivec2(0), size - 1);
            vec3 cQ = texelFetch(uColor, q, 0).rgb;
            vec4 gQ = texelFetch(uGuide, q, 0);

            float w = KERNEL[abs(x)] * KERNEL[abs(y)];
            // Distance: don't mix fluid with background, or near surfaces with far ones.
            w *= exp(-abs(gP.w - gQ.w) / (0.05 * float(uStep)));
            // Normal: don't mix surfaces facing different ways.
            float lenQ = length(gQ.xyz);
            if (lenP > 0.01 && lenQ > 0.01) w *= pow(max(dot(gP.xyz / lenP, gQ.xyz / lenQ), 0.0), 32.0);
            // Colour: only mix values that differ by about the noise level, so real detail survives.
            w *= exp(-abs(lum(cP) - lum(cQ)) / sigmaL);

            sum += cQ * w;
            wsum += w;
        }
    }
    fragColor = vec4(sum / wsum, 1.0);
}

