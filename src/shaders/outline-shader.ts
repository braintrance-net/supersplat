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

    // glass parameters
    const float IOR = 1.15;
    const float THICKNESS = 0.6;
    const float CHROMA_AB = 0.012;
    const float FRESNEL_POWER = 3.0;
    const int DIST_SAMPLES = 5;  // distance field sample radius (keep low for perf)

    void main(void) {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        vec2 texSize = vec2(textureSize(srcTexture, 0));
        vec2 uv = gl_FragCoord.xy / texSize;
        vec2 pixelSize = 1.0 / texSize;

        float centerAlpha = texelFetch(srcTexture, texel, 0).a;
        bool inside = centerAlpha > alphaCutoff;

        if (!inside) {
            // -- OUTSIDE: soft outer glow --
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

            if (edgeDist <= 0.0) discard;

            // caustic-style outer glow
            vec3 glowClr = vec3(0.55, 0.82, 1.0);
            float glow = edgeDist * edgeDist * edgeDist;
            gl_FragColor = vec4(glowClr, glow * 0.5);
            return;
        }

        // -- INSIDE: glass marble effect --

        // Step 1: approximate distance from edge (how deep inside the selection)
        float minDist = float(DIST_SAMPLES) + 1.0;
        for (int x = -DIST_SAMPLES; x <= DIST_SAMPLES; x++) {
            for (int y = -DIST_SAMPLES; y <= DIST_SAMPLES; y++) {
                if (texelFetch(srcTexture, texel + ivec2(x, y), 0).a <= alphaCutoff) {
                    float d = length(vec2(x, y));
                    minDist = min(minDist, d);
                }
            }
        }

        // normalize: 0 at edge, 1 deep inside
        float depth = clamp(minDist / float(DIST_SAMPLES), 0.0, 1.0);

        // Step 2: compute mask gradient → surface normal direction
        float mL = texture2D(srcTexture, uv + vec2(-2.0 * pixelSize.x, 0.0)).a;
        float mR = texture2D(srcTexture, uv + vec2( 2.0 * pixelSize.x, 0.0)).a;
        float mD = texture2D(srcTexture, uv + vec2(0.0, -2.0 * pixelSize.y)).a;
        float mU = texture2D(srcTexture, uv + vec2(0.0,  2.0 * pixelSize.y)).a;
        vec2 grad = vec2(mR - mL, mU - mD);

        // Step 3: hemisphere — marble dome shape
        // depth=0 at edge (surface perpendicular to view)
        // depth=1 at center (surface facing camera)
        float dome = sqrt(max(depth, 0.0));  // hemisphere height
        vec3 normal = normalize(vec3(grad * 2.0, dome + 0.01));

        // Step 4: refraction — distort UVs through the glass surface
        // Snell's law approximation in screen space
        float eta = 1.0 / IOR;
        vec3 viewDir = vec3(0.0, 0.0, 1.0);
        vec3 refracted = refract(-viewDir, normal, eta);
        vec2 distortion = refracted.xy * THICKNESS * (1.0 - dome * 0.3);

        // Step 5: chromatic aberration — split R/G/B with different IOR
        float r = texture2D(sceneTexture, uv + distortion * (1.0 + CHROMA_AB)).r;
        float g = texture2D(sceneTexture, uv + distortion).g;
        float b = texture2D(sceneTexture, uv + distortion * (1.0 - CHROMA_AB)).b;
        vec3 refractedClr = vec3(r, g, b);

        // Step 6: fresnel — reflection at edges of the marble
        float fresnel = pow(1.0 - dome, FRESNEL_POWER);
        vec3 reflectClr = vec3(0.7, 0.88, 1.0);  // environment reflection tint

        // Step 7: specular highlight — light glint on the marble surface
        vec3 lightDir = normalize(vec3(0.4, 0.6, 1.0));
        vec3 halfVec = normalize(lightDir + viewDir);
        float spec = pow(max(dot(normal, halfVec), 0.0), 64.0);
        float specEdge = pow(max(dot(normal, halfVec), 0.0), 16.0);

        // Step 8: combine
        vec3 glass = mix(refractedClr, reflectClr, fresnel * 0.4);
        glass += vec3(1.0) * spec * 0.6;           // sharp specular
        glass += reflectClr * specEdge * 0.15;      // soft broad highlight

        // edge darkening (glass thickness at rim)
        float edgeDarken = smoothstep(0.0, 0.15, depth);
        glass *= 0.7 + 0.3 * edgeDarken;

        // the glass effect is composited ON TOP of the existing render,
        // so we output the difference as an additive/alpha blend
        vec3 original = texture2D(sceneTexture, uv).rgb;
        vec3 diff = glass - original;

        float alpha = fresnel * 0.5 + spec * 0.6 + (1.0 - edgeDarken) * 0.3;
        alpha = clamp(alpha, 0.0, 0.85);

        gl_FragColor = vec4(glass, alpha);
    }
`;

export { vertexShader, fragmentShader };
