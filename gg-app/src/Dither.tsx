import { forwardRef, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { EffectComposer, wrapEffect } from "@react-three/postprocessing";
import { Effect } from "postprocessing";
import * as THREE from "three";

/**
 * Dithered, slowly flowing noise waves: React Bits' <Dither /> (reactbits.dev),
 * adapted to this codebase. Behaviour and shaders are unchanged; the port:
 * - types every uniform instead of `any`, with no non-null assertions;
 * - drops Tailwind classes (the app has none) for a plain full-size canvas;
 * - builds the wrapped post effect once, not on every render;
 * - takes `frameloop` so a caller can pause rendering (an unfocused window,
 *   reduced motion) instead of burning the GPU in the background.
 * Lives in its own lazily loaded chunk: see HomeDither.tsx.
 */

const waveVertexShader = `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 modelPosition = modelMatrix * vec4(position, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const waveFragmentShader = `
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float waveSpeed;
uniform float waveFrequency;
uniform float waveAmplitude;
uniform vec3 waveColor;
uniform vec3 backgroundColor;
uniform vec2 mousePos;
uniform int enableMouseInteraction;
uniform float mouseRadius;

vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

const int OCTAVES = 4;
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  float freq = waveFrequency;
  for (int i = 0; i < OCTAVES; i++) {
    value += amp * abs(cnoise(p));
    p *= freq;
    amp *= waveAmplitude;
  }
  return value;
}

float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2));
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  uv -= 0.5;
  uv.x *= resolution.x / resolution.y;
  float f = pattern(uv);
  if (enableMouseInteraction == 1) {
    vec2 mouseNDC = (mousePos / resolution - 0.5) * vec2(1.0, -1.0);
    mouseNDC.x *= resolution.x / resolution.y;
    float dist = length(uv - mouseNDC);
    float effect = 1.0 - smoothstep(0.0, mouseRadius, dist);
    f -= 0.5 * effect;
  }
  vec3 col = mix(backgroundColor, waveColor, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

const ditherFragmentShader = `
precision highp float;
uniform float colorNum;
uniform float pixelSize;
const float bayerMatrix8x8[64] = float[64](
  0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0,16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0,19.0/64.0, 47.0/64.0, 31.0/64.0,
  8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0,59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0,24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0,27.0/64.0, 39.0/64.0, 23.0/64.0,
  2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0,49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0,18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0,17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0,58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0,57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0,26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0,25.0/64.0, 37.0/64.0, 21.0/64.0
);

vec3 dither(vec2 uv, vec3 color) {
  vec2 scaledCoord = floor(uv * resolution / pixelSize);
  int x = int(mod(scaledCoord.x, 8.0));
  int y = int(mod(scaledCoord.y, 8.0));
  float threshold = bayerMatrix8x8[y * 8 + x] - 0.25;
  float step = 1.0 / (colorNum - 1.0);
  color += threshold * step;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float bias = mix(0.2, 0.0, smoothstep(0.45, 0.8, luminance));
  color = clamp(color - bias, 0.0, 1.0);
  return floor(color * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);
}

void mainImage(in vec4 inputColor, in vec2 uv, out vec4 outputColor) {
  vec2 normalizedPixelSize = pixelSize / resolution;
  vec2 uvPixel = normalizedPixelSize * floor(uv / normalizedPixelSize);
  vec4 color = texture2D(inputBuffer, uvPixel);
  color.rgb = dither(uv, color.rgb);
  outputColor = color;
}
`;

export type Rgb = readonly [number, number, number];

interface RetroOptions {
  colorNum?: number;
  pixelSize?: number;
}

/** The dither pass: quantises the rendered waves through an 8×8 Bayer matrix. */
class RetroEffectImpl extends Effect {
  private readonly colorNumUniform: THREE.Uniform<number>;
  private readonly pixelSizeUniform: THREE.Uniform<number>;

  // `wrapEffect` types its props from this first constructor argument; the
  // setters below apply later changes.
  constructor({ colorNum: initialColors = 4, pixelSize: initialPixel = 2 }: RetroOptions = {}) {
    const colorNum = new THREE.Uniform(initialColors);
    const pixelSize = new THREE.Uniform(initialPixel);
    super("RetroEffect", ditherFragmentShader, {
      uniforms: new Map<string, THREE.Uniform<number>>([
        ["colorNum", colorNum],
        ["pixelSize", pixelSize],
      ]),
    });
    this.colorNumUniform = colorNum;
    this.pixelSizeUniform = pixelSize;
  }

  set colorNum(value: number) {
    this.colorNumUniform.value = value;
  }
  get colorNum(): number {
    return this.colorNumUniform.value;
  }
  set pixelSize(value: number) {
    this.pixelSizeUniform.value = value;
  }
  get pixelSize(): number {
    return this.pixelSizeUniform.value;
  }
}

// Wrapped once at module scope: wrapping inside render (as the original did)
// creates a new component type each render and remounts the effect.
const WrappedRetroEffect = wrapEffect(RetroEffectImpl);

const RetroEffect = forwardRef<RetroEffectImpl, { colorNum: number; pixelSize: number }>(
  function RetroEffect({ colorNum, pixelSize }, ref) {
    return <WrappedRetroEffect ref={ref} colorNum={colorNum} pixelSize={pixelSize} />;
  },
);

interface WaveUniforms {
  [key: string]: THREE.IUniform;
  time: THREE.IUniform<number>;
  resolution: THREE.IUniform<THREE.Vector2>;
  waveSpeed: THREE.IUniform<number>;
  waveFrequency: THREE.IUniform<number>;
  waveAmplitude: THREE.IUniform<number>;
  waveColor: THREE.IUniform<THREE.Color>;
  backgroundColor: THREE.IUniform<THREE.Color>;
  mousePos: THREE.IUniform<THREE.Vector2>;
  enableMouseInteraction: THREE.IUniform<number>;
  mouseRadius: THREE.IUniform<number>;
}

interface DitheredWavesProps {
  waveSpeed: number;
  waveFrequency: number;
  waveAmplitude: number;
  waveColor: Rgb;
  backgroundColor: Rgb;
  colorNum: number;
  pixelSize: number;
  disableAnimation: boolean;
  enableMouseInteraction: boolean;
  mouseRadius: number;
}

function sameRgb(a: readonly number[], b: Rgb): boolean {
  return a.length === 3 && a.every((v, i) => v === b[i]);
}

function DitheredWaves({
  waveSpeed,
  waveFrequency,
  waveAmplitude,
  waveColor,
  backgroundColor,
  colorNum,
  pixelSize,
  disableAnimation,
  enableMouseInteraction,
  mouseRadius,
}: DitheredWavesProps): React.ReactElement {
  const mouse = useRef(new THREE.Vector2());
  const { viewport, size, gl, invalidate } = useThree();

  // Built once and handed to the material. three.js reads uniforms from the
  // material every frame, so they are updated in place through it (see
  // `waves()` below) rather than through this initial value.
  const [initialUniforms] = useState<WaveUniforms>(() => ({
    time: new THREE.Uniform(0),
    resolution: new THREE.Uniform(new THREE.Vector2(0, 0)),
    waveSpeed: new THREE.Uniform(waveSpeed),
    waveFrequency: new THREE.Uniform(waveFrequency),
    waveAmplitude: new THREE.Uniform(waveAmplitude),
    waveColor: new THREE.Uniform(new THREE.Color(...waveColor)),
    backgroundColor: new THREE.Uniform(new THREE.Color(...backgroundColor)),
    mousePos: new THREE.Uniform(new THREE.Vector2(0, 0)),
    enableMouseInteraction: new THREE.Uniform(enableMouseInteraction ? 1 : 0),
    mouseRadius: new THREE.Uniform(mouseRadius),
  }));
  const material = useRef<THREE.ShaderMaterial>(null);
  // The live uniforms, reached through the mounted material.
  const waves = (): WaveUniforms | null =>
    (material.current?.uniforms as WaveUniforms | undefined) ?? null;

  const prevWave = useRef<number[]>([...waveColor]);
  const prevBackground = useRef<number[]>([...backgroundColor]);
  useFrame(({ clock }) => {
    const uniforms = waves();
    if (!uniforms) return;
    // Cheap to set each frame, and never stale after a resize or remount.
    const dpr = gl.getPixelRatio();
    uniforms.resolution.value.set(Math.floor(size.width * dpr), Math.floor(size.height * dpr));
    if (!disableAnimation) uniforms.time.value = clock.getElapsedTime();
    uniforms.waveSpeed.value = waveSpeed;
    uniforms.waveFrequency.value = waveFrequency;
    uniforms.waveAmplitude.value = waveAmplitude;
    if (!sameRgb(prevWave.current, waveColor)) {
      uniforms.waveColor.value.setRGB(...waveColor);
      prevWave.current = [...waveColor];
    }
    if (!sameRgb(prevBackground.current, backgroundColor)) {
      uniforms.backgroundColor.value.setRGB(...backgroundColor);
      prevBackground.current = [...backgroundColor];
    }
    uniforms.enableMouseInteraction.value = enableMouseInteraction ? 1 : 0;
    uniforms.mouseRadius.value = mouseRadius;
    if (enableMouseInteraction) uniforms.mousePos.value.copy(mouse.current);
  });

  // New colours (a theme switch) only reach the uniforms in a frame, and an
  // on-demand canvas (reduced motion, unfocused window) draws none by itself.
  const [waveR, waveG, waveB] = waveColor;
  const [backR, backG, backB] = backgroundColor;
  useEffect(() => {
    invalidate();
  }, [invalidate, waveR, waveG, waveB, backR, backG, backB]);

  const handlePointerMove = (e: ThreeEvent<PointerEvent>): void => {
    if (!enableMouseInteraction) return;
    const canvas = gl.domElement;
    const rect = canvas.getBoundingClientRect();
    // Under the app's CSS zoom, client coordinates are zoomed but the canvas
    // resolution is in layout pixels; rescale so the ripple sits under the
    // pointer.
    const scale = rect.width > 0 ? canvas.offsetWidth / rect.width : 1;
    const dpr = gl.getPixelRatio();
    mouse.current.set((e.clientX - rect.left) * scale * dpr, (e.clientY - rect.top) * scale * dpr);
  };

  return (
    <>
      <mesh scale={[viewport.width, viewport.height, 1]}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          vertexShader={waveVertexShader}
          fragmentShader={waveFragmentShader}
          ref={material}
          uniforms={initialUniforms}
        />
      </mesh>

      <EffectComposer>
        <RetroEffect colorNum={colorNum} pixelSize={pixelSize} />
      </EffectComposer>

      <mesh
        onPointerMove={handlePointerMove}
        position={[0, 0, 0.01]}
        scale={[viewport.width, viewport.height, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </>
  );
}

export interface DitherProps {
  waveSpeed?: number;
  waveFrequency?: number;
  waveAmplitude?: number;
  waveColor?: Rgb;
  backgroundColor?: Rgb;
  colorNum?: number;
  pixelSize?: number;
  disableAnimation?: boolean;
  enableMouseInteraction?: boolean;
  mouseRadius?: number;
  /** `"demand"` renders only when something changes (the last frame stays). */
  frameloop?: "always" | "demand";
  /** Where pointer events are read from, e.g. the whole screen behind content. */
  eventSource?: HTMLElement;
}

export function Dither({
  waveSpeed = 0.05,
  waveFrequency = 3,
  waveAmplitude = 0.3,
  waveColor = [0.5, 0.5, 0.5],
  backgroundColor = [0, 0, 0],
  colorNum = 4,
  pixelSize = 2,
  disableAnimation = false,
  enableMouseInteraction = true,
  mouseRadius = 1,
  frameloop = "always",
  eventSource,
}: DitherProps): React.ReactElement {
  return (
    <Canvas
      className="dither-canvas"
      camera={{ position: [0, 0, 6] }}
      dpr={1}
      frameloop={frameloop}
      // Measure layout size, not the on-screen box: the app applies CSS
      // `zoom`, and a zoomed box drawn back inside the zoomed page shrinks
      // twice (the canvas stopped short of the right and bottom edges).
      resize={{ offsetSize: true }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      {...(eventSource ? { eventSource, eventPrefix: "client" as const } : {})}
    >
      <DitheredWaves
        waveSpeed={waveSpeed}
        waveFrequency={waveFrequency}
        waveAmplitude={waveAmplitude}
        waveColor={waveColor}
        backgroundColor={backgroundColor}
        colorNum={colorNum}
        pixelSize={pixelSize}
        disableAnimation={disableAnimation}
        enableMouseInteraction={enableMouseInteraction}
        mouseRadius={mouseRadius}
      />
    </Canvas>
  );
}
