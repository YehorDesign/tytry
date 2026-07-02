// Порт spring()/interpolate() из remotion для нативного рендера (без React/DOM).
// Математика повторена 1:1, чтобы вшитые субтитры совпадали с превью в плеере.

export type SpringConfig = {
  damping?: number;
  mass?: number;
  stiffness?: number;
  overshootClamping?: boolean;
};

const DEFAULT_SPRING = { damping: 10, mass: 1, stiffness: 100 };

type SpringState = {
  lastTimestamp: number;
  current: number;
  toValue: number;
  velocity: number;
};

function advance(state: SpringState, now: number, c: number, m: number, k: number): SpringState {
  const deltaTime = Math.min(now - state.lastTimestamp, 64);
  const v0 = -state.velocity;
  const x0 = state.toValue - state.current;
  const zeta = c / (2 * Math.sqrt(k * m));
  const omega0 = Math.sqrt(k / m);
  const omega1 = omega0 * Math.sqrt(1 - zeta ** 2);
  const t = deltaTime / 1000;

  if (zeta < 1) {
    const envelope = Math.exp(-zeta * omega0 * t);
    const sin1 = Math.sin(omega1 * t);
    const cos1 = Math.cos(omega1 * t);
    const frag = envelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
    return {
      toValue: state.toValue,
      lastTimestamp: now,
      current: state.toValue - frag,
      velocity:
        zeta * omega0 * frag - envelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1),
    };
  }
  // критическое затухание
  const envelope = Math.exp(-omega0 * t);
  return {
    toValue: state.toValue,
    lastTimestamp: now,
    current: state.toValue - envelope * (x0 + (v0 + omega0 * x0) * t),
    velocity: envelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0),
  };
}

function springCalculation(frame: number, fps: number, config: SpringConfig): SpringState {
  const c = config.damping ?? DEFAULT_SPRING.damping;
  const m = config.mass ?? DEFAULT_SPRING.mass;
  const k = config.stiffness ?? DEFAULT_SPRING.stiffness;
  let state: SpringState = { lastTimestamp: 0, current: 0, toValue: 1, velocity: 0 };
  const frameClamped = Math.max(0, frame);
  const unevenRest = frameClamped % 1;
  for (let f = 0; f <= Math.floor(frameClamped); f++) {
    if (f === Math.floor(frameClamped)) f += unevenRest;
    state = advance(state, (f / fps) * 1000, c, m, k);
  }
  return state;
}

const measureCache = new Map<string, number>();

function measureSpring(fps: number, config: SpringConfig, threshold = 0.005): number {
  const key = [fps, config.damping, config.mass, config.stiffness, threshold].join("-");
  const cached = measureCache.get(key);
  if (cached !== undefined) return cached;

  let frame = 0;
  let finishedFrame = 0;
  let diff = Math.abs(springCalculation(frame, fps, config).current - 1);
  while (diff >= threshold) {
    frame++;
    diff = Math.abs(springCalculation(frame, fps, config).current - 1);
  }
  finishedFrame = frame;
  for (let i = 0; i < 20; i++) {
    frame++;
    diff = Math.abs(springCalculation(frame, fps, config).current - 1);
    if (diff >= threshold) {
      i = 0;
      finishedFrame = frame + 1;
    }
  }
  measureCache.set(key, finishedFrame);
  return finishedFrame;
}

export function spring({
  frame,
  fps,
  config = {},
  durationInFrames,
}: {
  frame: number;
  fps: number;
  config?: SpringConfig;
  durationInFrames?: number;
}): number {
  let processed = frame;
  if (durationInFrames !== undefined) {
    const natural = measureSpring(fps, config);
    if (frame > durationInFrames) return 1;
    processed = frame / (durationInFrames / natural);
  }
  const spr = springCalculation(processed, fps, config);
  return config.overshootClamping ? Math.min(spr.current, 1) : spr.current;
}

export type EasingFn = (t: number) => number;

export const easeOutCubic: EasingFn = (t) => 1 - Math.pow(1 - t, 3);

export function interpolate(
  input: number,
  inputRange: [number, number],
  outputRange: [number, number],
  options?: { clampRight?: boolean; clampLeft?: boolean; easing?: EasingFn }
): number {
  const [i0, i1] = inputRange;
  const [o0, o1] = outputRange;
  let x = input;
  if (options?.clampRight && x > i1) x = i1;
  if (options?.clampLeft && x < i0) x = i0;
  let progress = (x - i0) / (i1 - i0);
  if (options?.easing) progress = options.easing(progress);
  return o0 + progress * (o1 - o0);
}
