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
            // -- OUTSIDE: wide outer glow --
            float edgeDist = 0.0;
            for (int x = -6; x <= 6; x++) {
                for (int y = -6; y <= 6; y++) {
                    if (x == 0 && y == 0) continue;
                    if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a > alphaCutoff) {
                        float d = 1.0 - length(vec2(x, y)) / 8.5;
                        edgeDist = max(edgeDist, d);
                    }
                }
            }

            if (edgeDist <= 0.0) discard;

            // bright cyan-white caustic glow
            vec3 glowClr = vec3(0.5, 0.8, 1.0);
            float glow = edgeDist * edgeDist;
            gl_FragColor = vec4(glowClr, glow * 0.9);
            return;
        }

        // -- INSIDE: glass marble --

        // distance from edge via 8-direction probes (wider reach)
        float minDist = 20.0;
        for (int r = 1; r <= 20; r++) {
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
        float depth = clamp(minDist / 20.0, 0.0, 1.0);

        // hemisphere dome shape
        float dome = sqrt(depth);

        // surface gradient for normal
        float mL = texelFetch(srcTexture, texel + ivec2(-4, 0), 0).a;
        float mR = texelFetch(srcTexture, texel + ivec2( 4, 0), 0).a;
        float mD = texelFetch(srcTexture, texel + ivec2(0, -4), 0).a;
        float mU = texelFetch(srcTexture, texel + ivec2(0,  4), 0).a;
        vec3 normal = normalize(vec3((mR - mL) * 3.0, (mU - mD) * 3.0, dome + 0.01));

        // fresnel — strong at edges, transparent at center
        float fresnel = pow(1.0 - dome, 2.0);

        // specular highlights
        vec3 viewDir = vec3(0.0, 0.0, 1.0);

        // main light (upper right) — big bright glint
        vec3 light1 = normalize(vec3(0.5, 0.7, 1.0));
        vec3 half1 = normalize(light1 + viewDir);
        float spec1 = pow(max(dot(normal, half1), 0.0), 64.0);

        // secondary light (lower left)
        vec3 light2 = normalize(vec3(-0.4, -0.3, 0.8));
        vec3 half2 = normalize(light2 + viewDir);
        float spec2 = pow(max(dot(normal, half2), 0.0), 24.0);

        // broad soft highlight across the dome
        float broadSpec = pow(max(dot(normal, viewDir), 0.0), 4.0);

        // chromatic rim — rainbow iridescence near edge
        float rimZone = smoothstep(0.0, 0.35, depth) * (1.0 - smoothstep(0.0, 0.6, depth));
        vec3 chromaClr = vec3(
            0.4 + 0.6 * sin(depth * 8.0 + 0.0),
            0.4 + 0.6 * sin(depth * 8.0 + 2.09),
            0.4 + 0.6 * sin(depth * 8.0 + 4.19)
        );

        // glass tint
        vec3 glassTint = vec3(0.55, 0.82, 1.0);

        // combine all effects
        vec3 result = vec3(0.0);
        result += glassTint * fresnel * 0.8;            // strong fresnel edge reflection
        result += vec3(1.0) * spec1 * 1.2;              // bright main specular
        result += vec3(0.7, 0.85, 1.0) * spec2 * 0.5;  // secondary specular
        result += glassTint * broadSpec * 0.15;          // broad dome sheen
        result += chromaClr * rimZone * 0.4;             // chromatic rim

        // edge band — bright white ring right at the boundary
        float edgeBand = (1.0 - smoothstep(0.0, 0.08, depth));
        result += vec3(0.8, 0.9, 1.0) * edgeBand * 0.6;

        // alpha: much more visible
        float alpha = fresnel * 0.8                     // strong edge visibility
                    + spec1 * 1.0                       // full specular
                    + spec2 * 0.5
                    + broadSpec * 0.1
                    + rimZone * 0.3
                    + edgeBand * 0.7;                   // bright edge ring

        alpha = clamp(alpha, 0.0, 0.92);

        gl_FragColor = vec4(result, alpha);
    }
`;

export { vertexShader, fragmentShader };
