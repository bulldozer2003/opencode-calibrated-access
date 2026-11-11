import { describe, expect, test } from "bun:test"
import { auc, maxOf, mean, stddev, summarize, sweepThresholds, variance, youdenThreshold } from "../benchmarks/bench-stats.ts"

describe("bench-stats", () => {
  test("mean averages values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(mean([5])).toBe(5)
  })

  test("mean of empty list is 0", () => {
    expect(mean([])).toBe(0)
  })

  test("maxOf returns the largest value", () => {
    expect(maxOf([1, 2, 3, 4])).toBe(4)
    expect(maxOf([])).toBe(0)
  })

  test("variance is population variance", () => {
    expect(variance([1, 2, 3, 4, 5])).toBeCloseTo(2, 10)
    expect(variance([1])).toBe(0)
    expect(variance([])).toBe(0)
  })

  test("stddev is the square root of variance", () => {
    expect(stddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 10)
  })

  test("summarize reports count/mean/max/variance/stddev", () => {
    const s = summarize([1, 2, 3, 4, 5])
    expect(s.count).toBe(5)
    expect(s.mean).toBe(3)
    expect(s.max).toBe(5)
    expect(s.variance).toBeCloseTo(2, 10)
    expect(s.stddev).toBeCloseTo(Math.sqrt(2), 10)
  })

  test("auc is 1 when positives always exceed negatives", () => {
    expect(auc([3, 4], [1, 2])).toBe(1)
  })

  test("auc is 0 when positives always trail negatives", () => {
    expect(auc([1, 2], [3, 4])).toBe(0)
  })

  test("auc counts a tie as half", () => {
    expect(auc([2], [1, 2])).toBe(0.75)
  })

  test("auc of empty class is 0.5 (no separation signal)", () => {
    expect(auc([], [1, 2])).toBe(0.5)
    expect(auc([1, 2], [])).toBe(0.5)
  })

  test("youdenThreshold finds a perfectly separating cut", () => {
    const result = youdenThreshold([0.9, 0.8], [0.1, 0.2])
    expect(result.j).toBe(1)
    expect(result.threshold).toBeGreaterThanOrEqual(0.2)
    expect(result.threshold).toBeLessThanOrEqual(0.8)
  })

  test("sweepThresholds emits a monotone curve over candidates", () => {
    const curve = sweepThresholds([0.9, 0.8], [0.1, 0.2])
    expect(curve.length).toBeGreaterThan(0)
    for (const point of curve) {
      expect(point.threshold).toBeGreaterThanOrEqual(0)
      expect(point.threshold).toBeLessThanOrEqual(1)
      expect(point.tpr).toBeGreaterThanOrEqual(0)
      expect(point.fpr).toBeGreaterThanOrEqual(0)
    }
    const nonIncreasingTpr = curve.every((p, i) => i === 0 || p.tpr <= curve[i - 1]!.tpr + 1e-9)
    expect(nonIncreasingTpr).toBe(true)
  })
})
