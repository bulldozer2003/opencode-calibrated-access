export interface Summary {
  count: number
  mean: number
  max: number
  variance: number
  stddev: number
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

export function maxOf(values: number[]): number {
  let best = 0
  for (const value of values) {
    if (value > best) best = value
  }
  return best
}

export function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mu = mean(values)
  let acc = 0
  for (const value of values) acc += (value - mu) ** 2
  return acc / values.length
}

export function stddev(values: number[]): number {
  return Math.sqrt(variance(values))
}

export function summarize(values: number[]): Summary {
  return {
    count: values.length,
    mean: mean(values),
    max: maxOf(values),
    variance: variance(values),
    stddev: stddev(values),
  }
}

/**
 * ROC AUC via the Mann-Whitney U statistic: the probability that a random
 * positive sample scores higher than a random negative sample, counting ties as
 * 0.5. Returns 0.5 when either class is empty (no separability signal).
 */
export function auc(positive: number[], negative: number[]): number {
  if (positive.length === 0 || negative.length === 0) return 0.5
  let wins = 0
  for (const p of positive) {
    for (const n of negative) {
      if (p > n) wins += 1
      else if (p === n) wins += 0.5
    }
  }
  return wins / (positive.length * negative.length)
}

export interface ThresholdPoint {
  threshold: number
  tpr: number
  fpr: number
  j: number
}

function tprAt(positive: number[], threshold: number): number {
  if (positive.length === 0) return 0
  return positive.filter((p) => p >= threshold).length / positive.length
}

function fprAt(negative: number[], threshold: number): number {
  if (negative.length === 0) return 0
  return negative.filter((n) => n >= threshold).length / negative.length
}

/**
 * Sweep every observed score as a candidate threshold and report the true- and
 * false-positive rates plus Youden's J (tpr - fpr) at each cut. The first point
 * is the always-fire cut (threshold 0, tpr=1, fpr=1) and the last is the
 * never-fire cut (threshold above max observed, tpr=0, fpr=0), so tpr is
 * non-increasing across the curve.
 */
export function sweepThresholds(positive: number[], negative: number[], steps = 21): ThresholdPoint[] {
  const candidates = new Set<number>([0])
  for (let i = 0; i < steps; i++) {
    candidates.add(Math.round((i / (steps - 1)) * 100) / 100)
  }
  for (const value of [...positive, ...negative]) {
    candidates.add(Math.round(value * 1000) / 1000)
  }
  candidates.add(1)
  const curve: ThresholdPoint[] = []
  for (const threshold of [...candidates].sort((a, b) => a - b)) {
    const tpr = tprAt(positive, threshold)
    const fpr = fprAt(negative, threshold)
    curve.push({ threshold, tpr, fpr, j: tpr - fpr })
  }
  return curve
}

/**
 * The threshold maximising Youden's J (tpr - fpr). Ties resolve to the highest
 * threshold, which keeps the false-positive rate minimal among equally good
 * cuts.
 */
export function youdenThreshold(positive: number[], negative: number[]): ThresholdPoint {
  let best: ThresholdPoint = { threshold: 0, tpr: 0, fpr: 0, j: -Infinity }
  for (const point of sweepThresholds(positive, negative)) {
    if (point.j > best.j || (point.j === best.j && point.threshold > best.threshold)) {
      best = point
    }
  }
  return best
}

/**
 * Per-signal separation margin between two scenario masses (e.g. benign mass
 * versus clearly-bad mass), as an ROC-style summary: AUC plus the best Youden
 * cut. `margin` is the mean difference (positive mean minus negative mean);
 * positive means the positive class scores higher on average.
 */
export interface SeparationMargin {
  auc: number
  margin: number
  threshold: number
  tpr: number
  fpr: number
  positiveMean: number
  negativeMean: number
}

export function separationMargin(positive: number[], negative: number[]): SeparationMargin {
  const best = youdenThreshold(positive, negative)
  return {
    auc: auc(positive, negative),
    margin: round4(mean(positive) - mean(negative)),
    threshold: best.threshold,
    tpr: best.tpr,
    fpr: best.fpr,
    positiveMean: round4(mean(positive)),
    negativeMean: round4(mean(negative)),
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
