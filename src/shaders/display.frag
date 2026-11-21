#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uExposure;
out vec4 fragColor;

vec3 aces(vec3 x)
{
    //Narkowicz fit
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main()
{
    vec3 c = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb * uExposure;
    c = pow(aces(c), vec3(1.0/ 2.2));

    // 1-LSB dither stops banding in dark gradients (important for H.264)
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    fragColor = vec4(c + (n - 0.5) / 255.0, 1.0);
}