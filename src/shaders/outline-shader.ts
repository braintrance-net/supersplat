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

        // skip pixels inside the selection
        if (texelFetch(srcTexture, texel, 0).a > alphaCutoff) {
            discard;
        }

        // detect edge proximity: find closest selected neighbor
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

        // glowing glass edge — cyan-white with soft falloff
        vec3 innerClr = vec3(0.7, 0.92, 1.0);  // bright cyan-white
        vec3 outerClr = vec3(0.3, 0.6, 1.0);   // deeper blue at outer edge
        vec3 edgeClr = mix(outerClr, innerClr, edgeDist);

        float glow = edgeDist * edgeDist;
        gl_FragColor = vec4(edgeClr, glow * 0.9);
    }
`;

export { vertexShader, fragmentShader };
