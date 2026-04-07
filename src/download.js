import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"
chromium.use(StealthPlugin())
import fs from "fs"
import path from "path"

const BACKUP_CODE_FILE = path.join(process.cwd(), ".backup_code")
const INITIAL_BACKUP_CODE = "KTMX-KIXP"

export function getBackupCode() {
  if (fs.existsSync(BACKUP_CODE_FILE)) {
    const code = fs.readFileSync(BACKUP_CODE_FILE, "utf8").trim()
    if (code) return code
  }
  return INITIAL_BACKUP_CODE
}

export function saveBackupCode(code) {
  fs.writeFileSync(BACKUP_CODE_FILE, code)
  log("INFO", "Saved new backup code to .backup_code", { code })
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function log(level, message, data) {
  const ts = new Date().toISOString()
  const payload = data ? { ...data } : undefined
  const logMsg = payload
    ? `[${ts}] ${level} ${message} ${JSON.stringify(payload)}\n`
    : `[${ts}] ${level} ${message}\n`
  console.log(logMsg.trim())
  try {
    fs.appendFileSync(path.join(process.cwd(), "run_trace.log"), logMsg)
  } catch (e) {}
}

function clearSessionData() {
  const userDataDir = path.join(process.cwd(), ".playwright-data")
  const sessionPath = path.join(process.cwd(), ".bc-session.json")
  try {
    if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true })
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true })
    log("INFO", "Cleared session data")
  } catch (e) {
    log("WARN", "Failed to clear session data", { message: e.message })
  }
}

/**
 * STEP 1 & 2: Handle the Join-RFP page
 * - Fill email in the "Sign up" form
 * - Wait for "Sign in" button to appear and click it
 * This redirects to Autodesk login
 */
async function handleJoinRfpPage(page, email, outputDir) {
  const takeShot = async (name) => {
    try {
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })
      log("INFO", "Screenshot saved", { name })
    } catch (e) {}
  }

  log("INFO", "Join-RFP: Filling email in sign-up form")
  await takeShot("joinrfp_01_start")

  const emailInput = page.locator('input[placeholder="Email"], input[type="email"], input[type="text"]')
  await emailInput.first().waitFor({ state: "visible", timeout: 30000 })
  await emailInput.first().click()
  await emailInput.first().fill("")
  // Type character by character so React state updates
  await page.keyboard.type(email, { delay: 80 })
  await page.waitForTimeout(1500)
  await takeShot("joinrfp_02_email_filled")

  // Sign in button may be a button or any clickable element - try multiple selectors
  log("INFO", "Join-RFP: Waiting for Sign in button to appear")
  const signInBtn = page.locator('div[class*="SignUpButton"]')
  await signInBtn.waitFor({ state: "visible", timeout: 15000 })
  await signInBtn.click()
  log("INFO", "Join-RFP: Clicked Sign in button")
  await page.waitForTimeout(3000)
  await takeShot("joinrfp_03_sign_in_clicked")
}

/**
 * STEP 3 & 4: Handle Autodesk login
 * - Fill email → click Next
 * - Fill password → click Sign in
 */
async function handleAutodeskLogin(page, email, password, outputDir) {
  const takeShot = async (name) => {
    try {
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })
      log("INFO", "Screenshot saved", { name })
    } catch (e) {}
  }

  log("INFO", "Autodesk: Waiting for email field")
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]')
  await emailInput.first().waitFor({ state: "visible", timeout: 30000 })
  await emailInput.first().click()
  await emailInput.first().fill(email)
  await page.waitForTimeout(500)
  await takeShot("autodesk_01_email_filled")

  log("INFO", "Autodesk: Clicking Next")
  const nextBtn = page.getByRole("button", { name: "Next", exact: true })
  await nextBtn.waitFor({ state: "visible", timeout: 15000 })
  await nextBtn.click()
  await takeShot("autodesk_02_next_clicked")

  log("INFO", "Autodesk: Waiting for password field")
  const passwordField = page.locator('input[type="password"]:not([disabled])')
  try {
    await passwordField.first().waitFor({ state: "visible", timeout: 30000 })
  } catch (e) {
    const disabledPassword = page.locator('input[type="password"]')
    if (await disabledPassword.count() > 0) {
      await takeShot("autodesk_03_password_disabled")
      throw new Error("Autodesk password field is disabled")
    }
    throw e
  }
  await passwordField.first().click()
  await passwordField.first().fill(password)
  await page.waitForTimeout(2000 + Math.random() * 1000)
  await page.waitForTimeout(500)
  await takeShot("autodesk_03_password_filled")

  log("INFO", "Autodesk: Clicking Sign in")
  const signInBtn = page.getByRole("button", { name: "Sign in", exact: true })
  await signInBtn.waitFor({ state: "visible", timeout: 15000 })
  await signInBtn.click()
  await page.waitForTimeout(3000)
  await takeShot("autodesk_04_signed_in")
}

/**
 * STEP 5: Handle 2FA - "Confirm sign-in" screen
 * The code is sent to email, but we skip it by clicking "Use a backup code"
 */
async function handle2FA(page, outputDir) {
  const takeShot = async (name) => {
    try {
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })
      log("INFO", "Screenshot saved", { name })
    } catch (e) {}
  }

  log("INFO", "2FA: Waiting for Confirm sign-in screen")
  // Wait for 2FA screen
  await page.waitForSelector('text="Confirm sign-in"', { timeout: 30000 })
  await takeShot("2fa_01_confirm_screen")

  log("INFO", "2FA: Clicking Use a backup code")
  const backupLink = page.getByRole("link", { name: "Use a backup code", exact: true })
  await backupLink.waitFor({ state: "visible", timeout: 15000 })
  await backupLink.click()
  await page.waitForTimeout(2000)
  await takeShot("2fa_02_backup_code_screen")
}

/**
 * STEP 6: Enter backup code
 * The UI has two groups of 4 boxes separated by a "-"
 * e.g. KTMX - KIXP → 8 individual character boxes
 */
async function enterBackupCode(page, outputDir) {
  const takeShot = async (name) => {
    try {
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })
      log("INFO", "Screenshot saved", { name })
    } catch (e) {}
  }

  log("INFO", "Backup code: Waiting for Enter backup code screen")
  await page.waitForSelector('text="Enter backup code"', { timeout: 30000 })

  const code = getBackupCode()
  const cleanCode = code.replace(/-/g, "") // e.g. "KTMXKIXP"
  log("INFO", "Backup code: Entering code", { code })

  // The page shows individual character input boxes
  // Find all the small input boxes for the code
  const codeInputs = page.locator('input[type="text"], input[type="tel"]')
  await codeInputs.first().waitFor({ state: "visible", timeout: 15000 })
  const inputCount = await codeInputs.count()
  log("INFO", "Backup code: Found input boxes", { count: inputCount })

  if (inputCount >= 8) {
    // Individual character boxes - fill each one
    for (let i = 0; i < Math.min(inputCount, cleanCode.length); i++) {
      await codeInputs.nth(i).click()
      await codeInputs.nth(i).fill(cleanCode[i])
      await page.waitForTimeout(100)
    }
  } else if (inputCount === 2) {
    // Two boxes: first 4 chars and last 4 chars
    await codeInputs.nth(0).click()
    await codeInputs.nth(0).fill(cleanCode.slice(0, 4))
    await page.waitForTimeout(200)
    await codeInputs.nth(1).click()
    await codeInputs.nth(1).fill(cleanCode.slice(4))
  } else if (inputCount === 1) {
    // Single box - type full code
    await codeInputs.first().click()
    await codeInputs.first().fill(code)
  } else {
    // Fallback: type the code with keyboard
    await codeInputs.first().click()
    await page.keyboard.type(cleanCode, { delay: 150 })
  }

  await page.waitForTimeout(1000)
  await takeShot("backup_01_code_entered")

  log("INFO", "Backup code: Clicking Next")
  const nextBtn = page.getByRole("button", { name: "Next", exact: true })
  await nextBtn.waitFor({ state: "visible", timeout: 15000 })
  await nextBtn.click()
  await page.waitForTimeout(3000)
  await takeShot("backup_02_next_clicked")

  return code
}

/**
 * STEP 7: Save new backup code
 * Page shows the new code, checkbox "I saved my backup code", and "Continue" button
 */
async function saveNewBackupCode(page, oldCode, outputDir) {
  const takeShot = async (name) => {
    try {
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })
      log("INFO", "Screenshot saved", { name })
    } catch (e) {}
  }

  log("INFO", "New backup code: Waiting for Save new backup code screen")
  await page.waitForSelector('text="Save new backup code"', { timeout: 30000 })
  await takeShot("newcode_01_screen")

  // Scan body text for the new backup code pattern XXXX-XXXX
  const bodyText = await page.innerText("body")
  const codePattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/g
  const matches = [...bodyText.matchAll(codePattern)]
  const candidates = matches.map(m => m[0]).filter(c => c !== oldCode)

  if (candidates.length > 0) {
    const newCode = candidates[0]
    saveBackupCode(newCode)
    log("INFO", "New backup code captured and saved", { newCode })
  } else {
    log("WARN", "Could not find new backup code in page text")
  }

  // Check the "I saved my backup code" checkbox
  log("INFO", "New backup code: Checking 'I saved my backup code' checkbox")
  const checkbox = page.locator('input[type="checkbox"]')
  await checkbox.waitFor({ state: "visible", timeout: 15000 })
  await checkbox.click()
  await page.waitForTimeout(500)
  await takeShot("newcode_02_checkbox_checked")

  // Click Continue
  log("INFO", "New backup code: Clicking Continue")
  const continueBtn = page.getByRole("button", { name: "Continue", exact: true })
  await continueBtn.waitFor({ state: "visible", timeout: 15000 })
  await continueBtn.click()
  await page.waitForTimeout(5000)
  await takeShot("newcode_03_continued")
}

export async function downloadOpportunityFiles({
  opportunityUrl,
  outputDir,
  headless = true,
  navTimeoutMs = 120000,
  waitTimeoutMs = 60000,
}) {
  const email = process.env.BC_EMAIL
  const password = process.env.BC_PASSWORD
  if (!opportunityUrl) return { success: false, error: "Missing opportunityUrl" }
  if (!outputDir) return { success: false, error: "Missing outputDir" }
  if (!email || !password) return { success: false, error: "Missing BC_EMAIL or BC_PASSWORD" }
  ensureDir(outputDir)

  const userDataDir = path.join(process.cwd(), ".playwright-data")
  ensureDir(userDataDir)

  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-gpu",
  ]

  log("INFO", "Start execution", { opportunityUrl, outputDir, headless })

  let context
  let page
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: launchArgs,
      acceptDownloads: true,
      proxy: { server: process.env.PROXY_URL },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      slowMo: headless ? 0 : 100,
      timeout: 120000,
    })

    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      window.chrome = { runtime: {} }
    })
    page.on("close", () => log("WARN", "Page closed unexpectedly"))
    page.on("crash", () => log("ERROR", "Page crashed"))

    // Navigate to the opportunity URL
   log("INFO", "Navigating to opportunity URL")
    let targetUrl = opportunityUrl
    try {
      const urlObj = new URL(opportunityUrl)
      const u = urlObj.searchParams.get("u")
      if (u) {
        targetUrl = decodeURIComponent(u)
        log("INFO", "Extracted direct URL from edgepilot link", { targetUrl })
      }
    } catch (e) {}
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
    await page.waitForTimeout(3000)

    // Handle EdgePilot redirect if needed
    if (page.url().includes("edgepilot")) {
      log("INFO", "EdgePilot redirect detected, waiting")
      try {
        await page.waitForURL((url) => !url.includes("edgepilot"), { timeout: 30000 })
      } catch (e) {
        // Try to extract the target URL from the edgepilot link
        try {
          const urlObj = new URL(page.url())
          const target = urlObj.searchParams.get("u")
          if (target) {
            await page.goto(decodeURIComponent(target), { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
          }
        } catch (e2) {}
      }
    }

    log("INFO", "Current URL after navigation", { url: page.url() })

    // PHASE 1: Handle Join-RFP page (the "Sign up" page with email + "I've used BuildingConnected before")
    // Replace all PHASE 1-5 checks with this loop
log("INFO", "Starting auth state machine")
const maxAuthWait = Date.now() + 120000 // 2 min total auth budget
let usedCode = getBackupCode()
while (Date.now() < maxAuthWait) {
  await page.waitForTimeout(1500)
  const url = page.url()
  const bodyText = await page.locator("body").innerText().catch(() => "")

  if (bodyText.includes("Save new backup code")) {
    log("INFO", "State: Save new backup code")
    const usedCode = getBackupCode()
    await saveNewBackupCode(page, usedCode, outputDir)

  } else if (bodyText.includes("Enter backup code")) {
    log("INFO", "State: Enter backup code")
    usedCode = await enterBackupCode(page, outputDir)

  } else if (bodyText.includes("Confirm sign-in")) {
    log("INFO", "State: 2FA confirm screen")
    await handle2FA(page, outputDir)

  } else if (url.includes("autodesk") && await page.locator('input[type="password"]').count() > 0) {
    log("INFO", "State: Autodesk password screen")
    const passwordField = page.locator('input[type="password"]:not([disabled])')
    await passwordField.waitFor({ state: "visible", timeout: 15000 })
    await passwordField.fill(password)
    await page.waitForTimeout(500)
    await page.getByRole("button", { name: "Sign in", exact: true }).click()

  } else if (url.includes("autodesk") && (bodyText.includes("Sign in") || bodyText.includes("Email"))) {
    log("INFO", "State: Autodesk email screen")
    await handleAutodeskLogin(page, email, password, outputDir)

  } else if (bodyText.includes("Sign up for a BuildingConnected") || url.includes("join-rfp")) {
    log("INFO", "State: Join-RFP sign-up page")
    await handleJoinRfpPage(page, email, outputDir)

  } else if (url.includes("buildingconnected.com") && !url.includes("join-rfp") && !url.includes("autodesk")) {
    log("INFO", "State: Logged in to BuildingConnected, proceeding")
    break

  } else {
    log("INFO", "State: Unknown, waiting...", { url })
  }
}

    // Wait to land on BuildingConnected after all auth
    log("INFO", "Waiting to land on BuildingConnected app")
    await page.waitForTimeout(5000)
    log("INFO", "Current URL after auth", { url: page.url() })

    // If we got redirected away from the opportunity, go back
    if (!page.url().includes("buildingconnected.com/opportunity") && !page.url().includes("buildingconnected.com/projects")) {
      log("INFO", "Navigating back to opportunity URL")
      await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
      await page.waitForTimeout(3000)
    }

    // Handle any post-login invitation buttons (Accept Invitation, View Opportunity, etc.)
    const postLoginBtns = [
      "Accept Invitation", "View Opportunity", "View Project", "Join Project", "Continue", "Accept"
    ]
    for (const btnName of postLoginBtns) {
      const btn = page.getByRole("button", { name: btnName, exact: true })
      if (await btn.count() > 0 && await btn.first().isVisible()) {
        log("INFO", `Clicking post-login button: ${btnName}`)
        await btn.first().click()
        await page.waitForTimeout(3000)
        break
      }
    }

    // PHASE 6: Click Files tab
    log("INFO", "Step 6: Clicking Files tab")
    const filesTab = page.getByRole("tab", { name: "Files", exact: true })
    const filesLink = page.getByRole("link", { name: "Files", exact: true })

    // Wait for tabs to appear
    const tabStart = Date.now()
    while (Date.now() - tabStart < 30000) {
      if (await filesTab.count() > 0 && await filesTab.first().isVisible()) {
        await filesTab.first().click()
        break
      }
      if (await filesLink.count() > 0 && await filesLink.first().isVisible()) {
        await filesLink.first().click()
        break
      }
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(3000)

    // PHASE 7: Click Download All
    log("INFO", "Step 7: Clicking Download All")
    const downloadAllBtn = page.getByRole("button", { name: "Download All", exact: true })
    await downloadAllBtn.first().waitFor({ state: "visible", timeout: 30000 })

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: waitTimeoutMs }),
      downloadAllBtn.first().click(),
    ])

    const suggested = download.suggestedFilename()
    const finalPath = path.join(outputDir, suggested)
    await download.saveAs(finalPath)
    log("INFO", "Download complete", { path: finalPath })

    // Clear session data after successful download
    clearSessionData()

    if (!headless && page && !page.isClosed()) {
      log("INFO", "Keeping browser open for 5 minutes...")
      await page.waitForTimeout(300000)
    }

    return { success: true, downloadedFiles: [finalPath], newBackupCode: getBackupCode() }
  } catch (err) {
    log("ERROR", "Automation failed", { message: err.message })
    if (!headless && page && !page.isClosed()) {
      log("INFO", "Error occurred. Keeping browser open for 5 minutes for debugging...")
      await page.waitForTimeout(300000)
    }
    return { success: false, error: err.message }
  } finally {
    if (context) {
      await context.close()
      await new Promise(r => setTimeout(r, 2000)) // wait for file handles to release
    }
    clearSessionData()
    log("INFO", "Finished execution")
  }
}
