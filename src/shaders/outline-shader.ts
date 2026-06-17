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

        vec4 centerMask = texelFetch(srcTexture, texel, 0);
        float centerAlpha = centerMask.a;
        bool inside = centerAlpha > alphaCutoff;
        vec3 fallbackClr = clr.rgb;

        if (!inside) {
            // -- OUTSIDE: outer glow (radius 4, axis-aligned samples only) --
            float edgeDist = 0.0;
            vec3 edgeClr = fallbackClr;
            for (int r = 1; r <= 4; r++) {
                float d = 1.0 - float(r) / 5.0;
                vec4 right = texelFetch(srcTexture, texel + ivec2( r,  0), 0);
                vec4 left = texelFetch(srcTexture, texel + ivec2(-r,  0), 0);
                vec4 up = texelFetch(srcTexture, texel + ivec2( 0,  r), 0);
                vec4 down = texelFetch(srcTexture, texel + ivec2( 0, -r), 0);

                if (right.a > alphaCutoff || left.a > alphaCutoff || up.a > alphaCutoff || down.a > alphaCutoff) {
                    edgeDist = max(edgeDist, d);
                    vec4 edgeSample = right.a > alphaCutoff ? right : (left.a > alphaCutoff ? left : (up.a > alphaCutoff ? up : down));
                    edgeClr = edgeSample.a > 0.0 && dot(edgeSample.rgb, edgeSample.rgb) > 0.0 ? edgeSample.rgb : fallbackClr;
                }
            }

            if (edgeDist <= 0.0) discard;

            float glow = edgeDist * edgeDist;
            gl_FragColor = vec4(edgeClr, glow * 0.85);
            return;
        }

        // -- INSIDE: lightweight edge-aware tint --

        // 4-direction edge distance (radius 8, 4 fetches per step)
        float minDist = 8.0;
        for (int r = 1; r <= 8; r++) {
            float rd = float(r);
            bool hitEdge = false;
            if (texelFetch(srcTexture, texel + ivec2( r,  0), 0).a <= alphaCutoff) hitEdge = true;
            if (texelFetch(srcTexture, texel + ivec2(-r,  0), 0).a <= alphaCutoff) hitEdge = true;
            if (texelFetch(srcTexture, texel + ivec2( 0,  r), 0).a <= alphaCutoff) hitEdge = true;
            if (texelFetch(srcTexture, texel + ivec2( 0, -r), 0).a <= alphaCutoff) hitEdge = true;
            if (hitEdge) {
                minDist = min(minDist, rd);
                break;
            }
        }

        // 0 = at edge, 1 = deep inside
        float depth = clamp(minDist / 8.0, 0.0, 1.0);

        // fresnel-like edge glow
        float edge = pow(1.0 - depth, 2.5);

        // bright edge band
        float edgeBand = 1.0 - smoothstep(0.0, 0.12, depth);

        vec3 selectionClr = dot(centerMask.rgb, centerMask.rgb) > 0.0 ? centerMask.rgb : fallbackClr;
        vec3 edgeHighlight = mix(selectionClr, vec3(1.0), 0.24);

        vec3 result = selectionClr * edge * 0.7 + edgeHighlight * edgeBand * 0.5;
        float alpha = edge * 0.6 + edgeBand * 0.65;
        alpha = clamp(alpha, 0.0, 0.85);

        gl_FragColor = vec4(result, alpha);
    }
`;

export { vertexShader, fragmentShader };
