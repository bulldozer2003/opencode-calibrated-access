import { readFileSync } from "fs"
import {
  analyzeCalibration,
  formatCalibrationReport,
  validateThresholdOverrides,
  type ThresholdMap,
} from "../src/calibration.ts"

interface Args {
  path?: string
  thresholds?: ThresholdMap
  margin?: number
  json: boolean
}

const USAGE =
  "Usage: bun run scripts/calibration-report.ts <diagnostics.jsonl> [--thresholds '<json>'] [--margin <0-1>] [--json]"

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--json") {
      args.json = true
    } else if (arg === "--margin") {
      const value = Number(argv[index + 1])
      index += 1
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("--margin must be a number from 0 to 1")
      args.margin = value
    } else if (arg === "--thresholds") {
      const raw = argv[index + 1]
      index += 1
      if (raw === undefined) throw new Error("--thresholds requires a JSON value")
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error("--thresholds is not valid JSON")
      }
      const validation = validateThresholdOverrides(parsed)
      if (!validation.ok) throw new Error(validation.error)
      args.thresholds = validation.thresholds
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`)
    } else if (args.path === undefined) {
      args.path = arg
    } else {
      throw new Error(`unexpected argument ${arg}`)
    }
  }
  return args
}

let args: Args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(USAGE)
  process.exit(1)
}

if (!args.path) {
  console.error(USAGE)
  process.exit(1)
}

let raw: string
try {
  raw = readFileSync(args.path, "utf-8")
} catch (error) {
  console.error(`Could not read ${args.path}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const report = analyzeCalibration(raw.split("\n"), {
  ...(args.thresholds ? { thresholds: args.thresholds } : {}),
  ...(args.margin !== undefined ? { margin: args.margin } : {}),
})

console.log(args.json ? JSON.stringify(report, null, 2) : formatCalibrationReport(report))
