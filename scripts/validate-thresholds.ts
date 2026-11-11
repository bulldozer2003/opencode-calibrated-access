import { validateThresholdOverrides } from "../src/calibration.ts"

const raw = process.argv[2]
if (!raw) {
  console.error(`Usage: bun run scripts/validate-thresholds.ts '{"destructive":{"block":0.9,"ask":0.7}}'`)
  process.exit(1)
}

let parsed: unknown
try {
  parsed = JSON.parse(raw)
} catch {
  console.error("signalThresholds is not valid JSON")
  process.exit(1)
}

const result = validateThresholdOverrides(parsed)
if (!result.ok) {
  console.error(`invalid signalThresholds: ${result.error}`)
  process.exit(1)
}

console.log("valid signalThresholds (defaults merged for omitted signals/fields):")
console.log(JSON.stringify(result.thresholds, null, 2))
