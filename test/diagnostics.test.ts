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

const lifeInput = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 100, seed: 42, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]] };

test('life estimate is reproducible for a fixed seed', () => {
  assert.deepEqual(estimateRemainingLife(lifeInput), estimateRemainingLife(lifeInput));
});

test('life estimate responds to the correlation matrix', () => {
  const low = estimateRemainingLife({ ...lifeInput, correlation: [[1, -0.9], [-0.9, 1]] });
  const high = estimateRemainingLife({ ...lifeInput, correlation: [[1, 0.9], [0.9, 1]] });
  assert.notDeepEqual(low, high);
  assert.ok(low.quantiles.p95! - low.quantiles.p05! < high.quantiles.p95! - high.quantiles.p05!);
});

test('life estimate conserves valid and rejected sample counts', () => {
  const result = estimateRemainingLife({ ...lifeInput, deviation: 0.0003 });
  assert.equal(result.validSamples + result.rejectedSamples, lifeInput.samples);
  assert.equal(Object.values(result.rejectedReasons).reduce((sum, count) => sum + count, 0), result.rejectedSamples);
  assert.ok(result.rejectedSamples > 0);
});

test('life estimate does not count censored samples as failures', () => {
  const result = estimateRemainingLife({ ...lifeInput, horizonHours: 10 });
  assert.equal(result.validSamples, lifeInput.samples);
  assert.equal(result.failureProbability, 0);
  assert.deepEqual(result.quantiles, { p05: null, p50: null, p95: null });
});

test('life estimate censors quantiles beyond the observed failure fraction', () => {
  const result = estimateRemainingLife({ ...lifeInput, horizonHours: 1_200 });
  assert.ok(result.failureProbability > 0.5 && result.failureProbability < 0.95);
  assert.ok(result.quantiles.p50 !== null);
  assert.equal(result.quantiles.p95, null);
});

test('life estimate reports zero remaining life when health loss exceeds the threshold', () => {
  const result = estimateRemainingLife({ ...lifeInput, failureThreshold: 0.05 });
  assert.equal(result.validSamples, lifeInput.samples);
  assert.equal(result.rejectedSamples, 0);
  assert.equal(result.failureProbability, 1);
  assert.deepEqual(result.quantiles, { p05: 0, p50: 0, p95: 0 });
});
