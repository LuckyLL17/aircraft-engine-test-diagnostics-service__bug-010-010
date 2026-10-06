import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseVibration } from '../src/domain/vibration/fuse.ts';
import { estimateRemainingLife } from '../src/domain/life/estimate.ts';
import { evaluatePerformance } from '../src/domain/performance/evaluate.ts';
import { replayTelemetry } from '../src/domain/timeline/replay.ts';

test('replay is deterministic and removes duplicate event ids', () => {
  const events = [
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
    { runId: 'run-1', eventId: 'a', sampleTimeMs: 1, receivedTimeMs: 3, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
  ] as any;
  assert.deepEqual(replayTelemetry(events).map((item) => item.eventId), ['a', 'b']);
});

test('performance produces physical normalized indicators', () => {
  const result = evaluatePerformance({ rpm: 9_000, fuelFlowKgPerSecond: 2, compressorOutletPressureKpa: 900, turbineInletTemperatureK: 1_000, ambientPressureKpa: 101.3, ambientTemperatureK: 288, inletPressureKpa: 100, referenceRpm: 10_000, referenceTemperatureK: 288, referencePressureKpa: 101.3 });
  assert.ok(result.pressureRatio > 1);
  assert.ok(result.compressorEfficiency >= 0 && result.compressorEfficiency <= 1);
});

test('vibration evidence is grouped by correlated source', () => {
  const result = diagnoseVibration([
    { evidenceId: 'a', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 0, windowEndMs: 100, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'b', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 20, windowEndMs: 80, feature: 'broadband', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'c', sensorId: 's2', sourceGroup: 'g2', windowStartMs: 200, windowEndMs: 300, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 3, amplitude: 2 },
  ]);
  assert.equal(result[0].evidenceIds.length, 2);
});

test('life estimate is reproducible for a fixed seed', () => {
  const input = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 100, seed: 42, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]] };
  assert.deepEqual(estimateRemainingLife(input), estimateRemainingLife(input));
});

const lifeInput = (overrides: Record<string, unknown> = {}) => ({ initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 2_000, seed: 7, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]], ...overrides });

test('life estimate conserves sample accounting and quantiles', () => {
  const input = lifeInput();
  const result = estimateRemainingLife(input);
  assert.equal(result.validSamples + result.rejectedSamples, input.samples);
  assert.equal(Object.values(result.rejectedReasons).reduce((sum, count) => sum + count, 0), result.rejectedSamples);
  const { p05, p50, p95 } = result.quantiles;
  assert.ok(p05 !== null && p50 !== null && p95 !== null);
  assert.ok(p05 <= p50 && p50 <= p95);
  assert.ok(p05 >= 0 && p95 <= input.horizonHours);
  assert.ok(result.failureProbability >= 0 && result.failureProbability <= 1);
});

test('life estimate does not count horizon-censored samples as failures', () => {
  const input = lifeInput({ horizonHours: 5 });
  const result = estimateRemainingLife(input);
  assert.equal(result.validSamples, input.samples);
  assert.equal(result.rejectedSamples, 0);
  assert.equal(result.failureProbability, 0);
  assert.equal(result.quantiles.p05, 5);
  assert.equal(result.quantiles.p95, 5);
});

test('life estimate reflects the correlation matrix in the sampled spread', () => {
  const positive = estimateRemainingLife(lifeInput({ samples: 4_000, seed: 11, correlation: [[1, 0.95], [0.95, 1]] }));
  const negative = estimateRemainingLife(lifeInput({ samples: 4_000, seed: 11, correlation: [[1, -0.95], [-0.95, 1]] }));
  assert.notDeepEqual(positive.quantiles, negative.quantiles);
  const spread = (quantiles: { p05: number | null; p95: number | null }) => (quantiles.p95 ?? 0) - (quantiles.p05 ?? 0);
  assert.ok(spread(positive.quantiles) > spread(negative.quantiles));
});

test('life estimate treats health already beyond the threshold as failed', () => {
  const input = lifeInput({ initialHealth: { compressorEfficiency: 0.5, turbineFlowCapacity: 0.9, bearingFriction: 0.05, hotSectionMargin: 0.4, elapsedHours: 900, version: 3 } });
  const result = estimateRemainingLife(input);
  assert.equal(result.rejectedSamples, 0);
  assert.equal(result.failureProbability, 1);
  assert.equal(result.quantiles.p50, 0);
});
