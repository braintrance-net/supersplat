const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;    // selection mask (workTarget)
    uniform sampler2D sceneTexture;  // rendered scene (mainTarget)
    uniform float alphaCutoff;
    uniform vec4 clr;

    void main(void) {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        vec2 texSize = vec2(textureSize(srcTexture, 0));
        vec2 uv = gl_FragCoord.xy / texSize;

        float centerAlpha = texelFetch(srcTexture, texel, 0).a;
        bool inside = centerAlpha > alphaCutoff;

        // compute selection mask gradient (surface normal of the bubble in screen space)
        float maskL = texelFetch(srcTexture, texel + ivec2(-2, 0), 0).a;
        float maskR = texelFetch(srcTexture, texel + ivec2( 2, 0), 0).a;
        float maskD = texelFetch(srcTexture, texel + ivec2(0, -2), 0).a;
        float maskU = texelFetch(srcTexture, texel + ivec2(0,  2), 0).a;
        vec2 grad = vec2(maskR - maskL, maskU - maskD);
        float gradLen = length(grad);

        if (inside) {
            // -- INSIDE THE BUBBLE --

            // edge proximity: how close are we to the boundary?
            // check for any neighbor that is NOT selected
            float edgeProximity = 0.0;
            for (int x = -4; x <= 4; x += 2) {
                for (int y = -4; y <= 4; y += 2) {
                    if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a <= alphaCutoff) {
                        float d = 1.0 - length(vec2(x, y)) / 5.66;
                        edgeProximity = max(edgeProximity, d);
                    }
                }
            }

            // glass refraction: distort the scene based on gradient
            vec2 refractOffset = grad * 0.004;
            vec3 sceneClr = texture2D(sceneTexture, uv + refractOffset).rgb;

            // fresnel at edges of the bubble (stronger effect near boundary)
            float fresnel = edgeProximity * edgeProximity;

            // specular highlight — fake a light reflection on the glass surface
            float specular = pow(max(dot(normalize(grad + vec2(0.001)), normalize(vec2(0.5, 0.7))), 0.0), 16.0);
            specular *= edgeProximity * 0.8;

            // glass tint at edges
            vec3 glassTint = vec3(0.6, 0.85, 1.0);
            vec3 result = mix(sceneClr, glassTint, fresnel * 0.25);
            result += vec3(specular);

            // subtle brightness boost inside the bubble
            result *= 1.0 + fresnel * 0.15;

            gl_FragColor = vec4(result, fresnel * 0.5 + specular);
        } else {
            // -- OUTSIDE THE BUBBLE --

            // find closest selected neighbor for outer glow
            float edgeDist = 0.0;
            for (int x = -3; x <= 3; x++) {
                for (int y = -3; y <= 3; y++) {
                    if (x == 0 && y == 0) continue;
                    if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a > alphaCutoff) {
                        float d = 1.0 - length(vec2(x, y)) / 4.24;
                        edgeDist = max(edgeDist, d);
                    }
                }
            }

            if (edgeDist <= 0.0) {
                discard;
            }

            // outer glow — soft cyan light bleeding out from the bubble
            vec3 glowClr = vec3(0.5, 0.8, 1.0);
            float glow = edgeDist * edgeDist * edgeDist;
            gl_FragColor = vec4(glowClr, glow * 0.6);
        }
    }
`;

export { vertexShader, fragmentShader };
