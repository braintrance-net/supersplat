const vertexShader = /* glsl*/`
#include "gsplatCommonVS"

uniform sampler2D splatState;
uniform sampler2D artisanConfidence;

uniform vec4 selectedClr;
uniform vec4 lockedClr;
uniform vec4 selectionRemovePreviewClr;
uniform vec4 selectionIntersectPreviewClr;
uniform float artisanConfidenceActive;
uniform float artisanConfidenceThreshold;
uniform float pointCloudWeight;
uniform float pointCloudRadius;
uniform float pointCloudOpacity;

uniform vec3 clrOffset;
uniform vec4 clrScale;

varying mediump vec4 texCoord_flags;            // xy: texCoord, z: selected, w: locked
varying mediump float removePreview;
varying mediump float intersectPreview;
varying mediump vec4 color;

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation
#endif

mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

uniform float saturation;

uniform float revealTime;
uniform vec3 revealCenter;
uniform float revealRadius;
uniform int revealActive;
uniform sampler2D revealMask;

vec3 applySaturation(vec3 color) {
    vec3 grey = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    return grey + (color - grey) * saturation;
}

// Absolute confidence color scale (mirrors confidenceRampColor in artisan-gs-local.ts):
// fixed 5-stop gradient over posterior mean 0..1, quantized into 0.05 buckets, so a color
// always means the same confidence range regardless of the selection threshold.
vec3 artisanConfidenceColor(float confidence, float threshold) {
    float bucket = 0.05;
    float c = clamp(confidence, 0.0, 1.0);
    float bucketed = min(1.0, (floor(c / bucket) + 0.5) * bucket);
    vec3 s0 = vec3(0.10, 0.20, 1.00);   // 0.00 deep blue
    vec3 s1 = vec3(0.00, 0.75, 0.95);   // 0.25 cyan
    vec3 s2 = vec3(1.00, 0.90, 0.20);   // 0.50 yellow
    vec3 s3 = vec3(1.00, 0.50, 0.10);   // 0.75 orange
    vec3 s4 = vec3(1.00, 0.10, 0.80);   // 1.00 pink/magenta
    float scaled = bucketed * 4.0;
    if (scaled < 1.0) return mix(s0, s1, scaled);
    if (scaled < 2.0) return mix(s1, s2, scaled - 1.0);
    if (scaled < 3.0) return mix(s2, s3, scaled - 2.0);
    return mix(s3, s4, scaled - 3.0);
}

void main(void) {
    // read gaussian details
    SplatSource source;
    if (!initSource(source)) {
        gl_Position = discardVec;
        return;
    }

    // get per-gaussian edit state, discard if deleted
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5);
    uint editState = vertexState & 7u;
    bool isRemovePreview = (vertexState & 8u) != 0u;
    bool isIntersectPreview = (vertexState & 16u) != 0u;

    #if PICK_PASS
        if (pickOp == 0u) {
            // add: skip deleted, locked and selected splats
            if (editState != 0u) {
                gl_Position = discardVec;
                return;
            }
        } else if (pickOp == 1u) {
            // remove: skip deleted, locked and unselected splats
            if (editState != 1u) {
                gl_Position = discardVec;
                return;
            }
        } else {
            // set: skip deleted and locked splats
            if ((editState & 6u) != 0u) {
                gl_Position = discardVec;
                return;
            }
        }
    #else
        // skip deleted splats
        if ((editState & 4u) != 0u) {
            gl_Position = discardVec;
            return;
        }
    #endif

    // get center
    vec3 modelCenter = getCenter();

    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) {
        gl_Position = discardVec;
        return;
    }

    SplatCorner corner;
    if (!initCorner(source, center, corner)) {
        gl_Position = discardVec;
        return;
    }

    #if FORWARD_PASS
        // Display-only point-cloud morph. Keep canonical Gaussian geometry for pick/depth
        // passes, but continuously shrink the forward footprint to a fixed screen-space disc.
        vec3 pointOffset = vec3(
            source.cornerUV * pointCloudRadius * center.proj.ww * viewport_size.zw,
            0.0
        );
        corner.offset = mix(corner.offset, pointOffset, clamp(pointCloudWeight, 0.0, 1.0));
    #endif

    // reveal animation: scale newly selected splats from center outward
    float revealT = 1.0;
    if (revealActive == 1 && texelFetch(revealMask, splat.uv, 0).r > 0.5) {
        float dist = length(modelCenter - revealCenter) / max(revealRadius, 0.001);
        float splatDelay = dist * 0.3;
        revealT = clamp((revealTime - splatDelay) / 0.3, 0.0, 1.0);
        revealT = 1.0 - (1.0 - revealT) * (1.0 - revealT);
        corner.offset *= revealT;
    }

    gl_Position = center.proj + vec4(corner.offset, 0.0);

    // store texture coord and locked state
    texCoord_flags = vec4(
        corner.uv,
        (editState & 1u) != 0u ? 1.0 : 0.0,         // selected
        (editState & 2u) != 0u ? 1.0 : 0.0          // locked
    );
    removePreview = isRemovePreview ? 1.0 : 0.0;
    intersectPreview = isIntersectPreview ? 1.0 : 0.0;

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            float linearDepth = -center.view.z;
            float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
            vec4 clr = getColor();
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        // evaluate spherical harmonics
        #if SH_BANDS > 0
        // calculate the model-space view direction
            vec3 dir = normalize(center.view * mat3(center.modelView));

            // read sh coefficients
            vec3 sh[SH_COEFFS];
            float scale;
            readSHData(sh, scale);

            // evaluate
            color.xyz += evalSH(sh, dir) * scale;
        #endif

        // apply tint/brightness
        color = color * clrScale + vec4(clrOffset, 0.0);

        // apply saturation
        color.xyz = applySaturation(color.xyz);

        // don't allow out-of-range alpha
        color.a = clamp(color.a, 0.0, 1.0);
        color.a *= mix(1.0, pointCloudOpacity, clamp(pointCloudWeight, 0.0, 1.0));

        // apply tonemapping
        color = vec4(prepareOutputFromGamma(max(color.xyz, 0.0)), color.w);

        // apply locked/selected colors
        if ((editState & 2u) != 0u) {
            // locked
            color *= lockedClr;
        } else if ((editState & 1u) != 0u && artisanConfidenceActive <= 0.5) {
            // selected: subtle brighten so splats pop under the glass bubble
            color.xyz *= 1.1;
        }

        if (artisanConfidenceActive > 0.5) {
            // Artisan inspect flow. Three visual states, keyed off the REAL selection so
            // what you see is exactly what will move:
            //   selected            -> SOLID GREEN
            //   selectable, unpicked -> posterior heatmap color
            //   unselectable (conf 0)-> original color, untouched
            bool artisanSelected = (editState & 1u) != 0u;
            float confidence = texelFetch(artisanConfidence, splat.uv, 0).r;
            if (artisanSelected) {
                // Retain a little original luminance so surface form stays legible
                // through the green, but keep it unmistakably solid green.
                float lum = dot(color.xyz, vec3(0.299, 0.587, 0.114));
                vec3 solidGreen = vec3(0.10, 0.95, 0.25) * (0.55 + 0.45 * lum);
                color.xyz = mix(color.xyz, solidGreen, 0.92);
                color.a = max(color.a, 0.97);
            } else if (confidence > 0.0) {
                vec3 confidenceClr = artisanConfidenceColor(confidence, artisanConfidenceThreshold);
                // Continuous emphasis so the heatmap reads the posterior mean directly
                // instead of a hard selected/unselected split at the threshold.
                float emphasis = smoothstep(0.0, 1.0, confidence);
                float blend = mix(0.72, 0.98, emphasis);
                color.xyz = mix(color.xyz, confidenceClr, blend);
                color.a = max(color.a, mix(0.4, 0.95, emphasis));
            }
        }
    #endif
}
`;

const fragmentShader = /* glsl*/`
varying mediump vec4 texCoord_flags;
varying mediump float removePreview;
varying mediump float intersectPreview;
varying mediump vec4 color;

uniform vec4 selectedClr;
uniform vec4 selectionRemovePreviewClr;
uniform vec4 selectionIntersectPreviewClr;
uniform bool outlineMode;
uniform float selectedSplatOverlay;
uniform float ringSize;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation
            mediump float alpha = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            // we should multiply by alpha here to take into account gaussian falloff,
            // but it results in less accurate depth for some reason
            gl_FragColor = color * alpha;
        } else {
            // pick id
            gl_FragColor = color;
        }
    #else
        mediump float norm = normExp(A);
        mediump float alpha = norm * color.a;

        if (texCoord_flags.w == 0.0 && ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        bool selected = texCoord_flags.z != 0.0 && texCoord_flags.w == 0.0;
        bool removePreviewed = removePreview > 0.5 && selected;
        bool intersectPreviewed = intersectPreview > 0.5 && selected;

        if (removePreviewed) {
            mediump float overlayAlpha = max(alpha, norm * max(selectionRemovePreviewClr.a, 0.85));
            vec3 overlayColor = mix(color.xyz, selectionRemovePreviewClr.xyz, 0.86);
            pcFragColor0 = vec4(overlayColor * overlayAlpha, overlayAlpha);
            pcFragColor1 = vec4(selectionRemovePreviewClr.xyz * overlayAlpha, overlayAlpha);
            return;
        }

        if (intersectPreviewed) {
            mediump float overlayAlpha = max(alpha, norm * max(selectionIntersectPreviewClr.a, 0.85));
            vec3 overlayColor = mix(color.xyz, selectionIntersectPreviewClr.xyz, 0.84);
            pcFragColor0 = vec4(overlayColor * overlayAlpha, overlayAlpha);
            pcFragColor1 = vec4(selectionIntersectPreviewClr.xyz * overlayAlpha, overlayAlpha);
            return;
        }

        if (selectedSplatOverlay > 0.5 && selected) {
            mediump float overlayAlpha = max(alpha, norm * max(selectedClr.a, 0.85));
            vec3 overlayColor = mix(color.xyz, selectedClr.xyz, 0.8);
            pcFragColor0 = vec4(overlayColor * overlayAlpha, overlayAlpha);
            pcFragColor1 = vec4(selectedClr.xyz * overlayAlpha, overlayAlpha);
            return;
        }

        if (outlineMode) {
            pcFragColor0 = vec4(color.xyz * alpha, alpha);
            pcFragColor1 = vec4(0.0, 0.0, 0.0, selected ? norm : 0.0);
        } else {
            if (selected) {
                pcFragColor0 = vec4(color.xyz * alpha * 0.8, alpha);
                pcFragColor1 = vec4(color.xyz * alpha * 0.2, alpha);
            } else {
                pcFragColor0 = vec4(color.xyz * alpha, alpha);
                pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
            }
        }
    #endif
}
`;

const gsplatCenter = /* glsl*/`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        // orthographic projections don't need this check as frustum culling handles it
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export { vertexShader, fragmentShader, gsplatCenter };
