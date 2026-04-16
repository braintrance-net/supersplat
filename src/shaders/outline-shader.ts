const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;    // selection mask (workTarget)
    uniform float alphaCutoff;
    uniform vec4 clr;

    void main(void) {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        vec2 texSize = vec2(textureSize(srcTexture, 0));
        vec2 uv = gl_FragCoord.xy / texSize;

        float centerAlpha = texelFetch(srcTexture, texel, 0).a;
        bool inside = centerAlpha > alphaCutoff;

        if (!inside) {
            // -- OUTSIDE: outer glow --
            float edgeDist = 0.0;
            for (int x = -4; x <= 4; x++) {
                for (int y = -4; y <= 4; y++) {
                    if (x == 0 && y == 0) continue;
                    if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a > alphaCutoff) {
                        float d = 1.0 - length(vec2(x, y)) / 5.66;
                        edgeDist = max(edgeDist, d);
                    }
                }
            }

            if (edgeDist <= 0.0) discard;

            // soft cyan caustic glow
            vec3 glowClr = vec3(0.4, 0.75, 1.0);
            float glow = edgeDist * edgeDist;
            gl_FragColor = vec4(glowClr, glow * 0.7);
            return;
        }

        // -- INSIDE: glass marble --

        // distance from edge via 8-direction probes
        float minDist = 12.0;
        for (int r = 1; r <= 12; r++) {
            float rd = float(r);
            if (texelFetch(srcTexture, texel + ivec2( r,  0), 0).a <= alphaCutoff) { minDist = min(minDist, rd); }
            if (texelFetch(srcTexture, texel + ivec2(-r,  0), 0).a <= alphaCutoff) { minDist = min(minDist, rd); }
            if (texelFetch(srcTexture, texel + ivec2( 0,  r), 0).a <= alphaCutoff) { minDist = min(minDist, rd); }
            if (texelFetch(srcTexture, texel + ivec2( 0, -r), 0).a <= alphaCutoff) { minDist = min(minDist, rd); }
            if (texelFetch(srcTexture, texel + ivec2( r,  r), 0).a <= alphaCutoff) { minDist = min(minDist, rd * 1.414); }
            if (texelFetch(srcTexture, texel + ivec2(-r, -r), 0).a <= alphaCutoff) { minDist = min(minDist, rd * 1.414); }
            if (texelFetch(srcTexture, texel + ivec2( r, -r), 0).a <= alphaCutoff) { minDist = min(minDist, rd * 1.414); }
            if (texelFetch(srcTexture, texel + ivec2(-r,  r), 0).a <= alphaCutoff) { minDist = min(minDist, rd * 1.414); }
        }

        // 0 = at edge, 1 = deep inside
        float depth = clamp(minDist / 12.0, 0.0, 1.0);

        // hemisphere dome shape
        float dome = sqrt(depth);

        // surface gradient for normal
        float mL = texelFetch(srcTexture, texel + ivec2(-3, 0), 0).a;
        float mR = texelFetch(srcTexture, texel + ivec2( 3, 0), 0).a;
        float mD = texelFetch(srcTexture, texel + ivec2(0, -3), 0).a;
        float mU = texelFetch(srcTexture, texel + ivec2(0,  3), 0).a;
        vec3 normal = normalize(vec3((mR - mL) * 2.0, (mU - mD) * 2.0, dome + 0.01));

        // fresnel — strong at edges (dome near 0), weak at center
        float fresnel = pow(1.0 - dome, 2.5);

        // specular highlights — two lights for more interesting reflections
        vec3 viewDir = vec3(0.0, 0.0, 1.0);

        // main light (upper right)
        vec3 light1 = normalize(vec3(0.5, 0.7, 1.0));
        vec3 half1 = normalize(light1 + viewDir);
        float spec1 = pow(max(dot(normal, half1), 0.0), 80.0);

        // secondary light (lower left, softer)
        vec3 light2 = normalize(vec3(-0.4, -0.3, 0.8));
        vec3 half2 = normalize(light2 + viewDir);
        float spec2 = pow(max(dot(normal, half2), 0.0), 32.0);

        // chromatic rim — rainbow at the very edge
        float rimZone = smoothstep(0.0, 0.3, depth) * (1.0 - smoothstep(0.0, 0.5, depth));
        vec3 chromaClr = vec3(
            0.3 + 0.7 * sin(depth * 6.28 + 0.0),
            0.3 + 0.7 * sin(depth * 6.28 + 2.09),
            0.3 + 0.7 * sin(depth * 6.28 + 4.19)
        );

        // glass tint color
        vec3 glassTint = vec3(0.6, 0.85, 1.0);

        // combine
        vec3 result = vec3(0.0);
        result += glassTint * fresnel * 0.5;          // fresnel reflection
        result += vec3(1.0) * spec1 * 0.8;            // main specular
        result += vec3(0.7, 0.85, 1.0) * spec2 * 0.3; // secondary specular
        result += chromaClr * rimZone * 0.25;          // chromatic rim

        // edge darkening (glass is thicker at rim)
        float edgeDarken = smoothstep(0.0, 0.12, depth);
        result *= 0.6 + 0.4 * edgeDarken;

        // alpha: visible at edges (fresnel) and specular highlights
        float alpha = fresnel * 0.6 + spec1 * 0.8 + spec2 * 0.3 + rimZone * 0.2;
        alpha *= edgeDarken * 0.8 + 0.2;  // fade at very edge to avoid hard line
        alpha = clamp(alpha, 0.0, 0.85);

        gl_FragColor = vec4(result, alpha);
    }
`;

export { vertexShader, fragmentShader };
