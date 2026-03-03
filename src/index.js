import "dotenv/config"
import path from "path"
import { downloadOpportunityFiles } from "./download.js"

function parseBool(v, d) {
  if (v === undefined) return d
  const s = String(v).toLowerCase()
  if (["1", "true", "yes", "y"].includes(s)) return true
  if (["0", "false", "no", "n"].includes(s)) return false
  return d
}

export { downloadOpportunityFiles }

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const opportunityUrlArg = process.env.OPPORTUNITY_URL || process.argv[2]
  const outputDirArg = process.env.OUTPUT_DIR || process.argv[3] || path.join(process.cwd(), "bc-downloads")
  const headlessArg = false // Force headless false for debugging
  const useSessionArg = parseBool(process.env.USE_SESSION ?? "true", true)
  run(opportunityUrlArg, outputDirArg, headlessArg, useSessionArg)
}

async function run(opportunityUrl, outputDir, headless, useSession) {
  if (!opportunityUrl) {
    console.log("Provide OPPORTUNITY_URL env or as first arg.")
    process.exitCode = 1
    return
  }
  const res = await downloadOpportunityFiles({
    opportunityUrl,
    outputDir,
    headless,
    useSession,
    navTimeoutMs: 300000,
    waitTimeoutMs: 300000,
  })
  console.log(JSON.stringify(res, null, 2))
}
