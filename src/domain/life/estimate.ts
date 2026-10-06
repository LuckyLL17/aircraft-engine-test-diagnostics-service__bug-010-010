import { DomainError, invariant } from '../errors.ts';
import type { LifeEstimate, LifeModelInput } from '../types.ts';

function rng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
}

function normal(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Cholesky factor of [[1, rho], [rho, 1]]: maps independent standard normals to a standard normal pair with correlation rho.
function correlatedPair(z1: number, z2: number, correlation: [[number, number], [number, number]]): [number, number] {
  const rho = correlation[0][1];
  return [z1, rho * z1 + Math.sqrt(1 - rho * rho) * z2];
}

// Censored draws exceed every observed failure, so a quantile is identifiable only while its sample index stays inside the observed failures.
function lifeQuantile(sortedFailures: number[], validSamples: number, probability: number): number | null {
  if (!sortedFailures.length || validSamples < 1) return null;
  const index = (validSamples - 1) * probability;
  if (index > sortedFailures.length - 1) return null;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedFailures[lower];
  return sortedFailures[lower] + (sortedFailures[upper] - sortedFailures[lower]) * (index - lower);
}

function healthLoss(input: LifeModelInput): number {
  const efficiencyLoss = Math.max(0, 1 - input.initialHealth.compressorEfficiency);
  const flowLoss = Math.max(0, 1 - input.initialHealth.turbineFlowCapacity);
  return efficiencyLoss + flowLoss + Math.max(0, input.initialHealth.bearingFriction);
}

function degradationRate(input: LifeModelInput, rateShock: number, stressShock: number): number {
  const shock = 0.5 * rateShock + 0.5 * stressShock;
  return input.meanDegradationPerHour + input.deviation * shock;
}

export function estimateRemainingLife(input: LifeModelInput): LifeEstimate {
  invariant(Number.isInteger(input.samples) && input.samples > 0, 'INVALID_SAMPLE_COUNT', 'Life sample count must be a positive integer');
  invariant(input.horizonHours > 0 && input.failureThreshold > 0, 'INVALID_LIFE_HORIZON', 'Life horizon and failure threshold must be positive');
  invariant(Math.abs(input.correlation[0][0] - 1) < 1e-9 && Math.abs(input.correlation[1][1] - 1) < 1e-9, 'INVALID_CORRELATION', 'Correlation diagonal must equal one');
  invariant(Math.abs(input.correlation[0][1]) < 1 && Math.abs(input.correlation[1][0]) < 1 && input.correlation[0][1] === input.correlation[1][0], 'INVALID_CORRELATION', 'Correlation matrix must be symmetric and bounded');
  const random = rng(input.seed);
  const stress = 1 + Math.max(0, input.temperatureStress) + Math.max(0, input.vibrationStress);
  const remaining = input.failureThreshold - healthLoss(input);
  const failures: number[] = [];
  let censoredSamples = 0;
  const rejectedReasons: Record<string, number> = {};
  for (let sample = 0; sample < input.samples; sample += 1) {
    const z1 = normal(random);
    const z2 = normal(random);
    const [rateShock, stressShock] = correlatedPair(z1, z2, input.correlation);
    const rate = degradationRate(input, rateShock, stressShock);
    if (!(rate > 0) || !Number.isFinite(rate)) { rejectedReasons.invalidDegradation = (rejectedReasons.invalidDegradation ?? 0) + 1; continue; }
    const failureAt = remaining / (rate * stress);
    if (!Number.isFinite(failureAt)) { rejectedReasons.invalidLife = (rejectedReasons.invalidLife ?? 0) + 1; continue; }
    const hours = Math.max(0, failureAt);
    if (hours <= input.horizonHours) failures.push(hours);
    else censoredSamples += 1;
  }
  failures.sort((a, b) => a - b);
  const validSamples = failures.length + censoredSamples;
  return { quantiles: { p05: lifeQuantile(failures, validSamples, 0.05), p50: lifeQuantile(failures, validSamples, 0.5), p95: lifeQuantile(failures, validSamples, 0.95) }, failureProbability: validSamples ? failures.length / validSamples : 0, validSamples, rejectedSamples: input.samples - validSamples, rejectedReasons };
}
