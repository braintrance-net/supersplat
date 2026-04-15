const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;
    uniform float alphaCutoff;
    uniform vec4 clr;

    void main(void) {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        vec2 texSize = vec2(textureSize(srcTexture, 0));
        vec2 uv = gl_FragCoord.xy / texSize;

        // skip solid pixels (inside selection)
        if (texelFetch(srcTexture, texel, 0).a > alphaCutoff) {
            discard;
        }

        // detect edge: check if any neighbor is inside the selection
        float edgeDist = 0.0;
        for (int x = -3; x <= 3; x++) {
            for (int y = -3; y <= 3; y++) {
                if (x == 0 && y == 0) continue;
                if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a > alphaCutoff) {
                    float d = 1.0 - length(vec2(x, y)) / 4.24; // normalize by max dist (3*sqrt(2))
                    edgeDist = max(edgeDist, d);
                }
            }
        }

        if (edgeDist <= 0.0) {
            discard;
        }

        // glass distortion: sample background with chromatic offset
        float distortStr = edgeDist * 2.0 / texSize.x;
        vec2 distortDir = normalize(vec2(
            texelFetch(srcTexture, texel + ivec2(1, 0), 0).a -
            texelFetch(srcTexture, texel + ivec2(-1, 0), 0).a,
            texelFetch(srcTexture, texel + ivec2(0, 1), 0).a -
            texelFetch(srcTexture, texel + ivec2(0, -1), 0).a
        ) + vec2(0.001));

        // chromatic aberration — split R/G/B
        float r = texture2D(srcTexture, uv + distortDir * distortStr * 1.5).r;
        float g = texture2D(srcTexture, uv + distortDir * distortStr * 0.5).g;
        float b = texture2D(srcTexture, uv - distortDir * distortStr * 0.5).b;
        vec3 refracted = vec3(r, g, b);

        // fresnel rim: bright white-blue glow strongest at edge
        vec3 rimClr = vec3(0.75, 0.88, 1.0);
        float rimAlpha = edgeDist * edgeDist * 0.7;

        vec3 finalClr = mix(refracted, rimClr, rimAlpha);
        float finalAlpha = edgeDist * 0.85;

        gl_FragColor = vec4(finalClr, finalAlpha);
    }
`;

export { vertexShader, fragmentShader };
