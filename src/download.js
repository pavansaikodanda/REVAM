import { chromium } from "playwright"
import fs from "fs"
import path from "path"

const LOGIN_URL = "https://app.buildingconnected.com/login"
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
  log("INFO", "Saved new backup code to .backup_code")
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function log(level, message, data) {
  const ts = new Date().toISOString()
  const payload = data ? { ...data } : undefined
  const logMsg = payload ? `[${ts}] ${level} ${message} ${JSON.stringify(payload)}\n` : `[${ts}] ${level} ${message}\n`
  console.log(logMsg.trim())
  try {
    fs.appendFileSync(path.join(process.cwd(), "run_trace.log"), logMsg)
  } catch (e) {}
}

async function performLogin(page, email, password, timeout, headless, outputDir) {
  try {
    log("INFO", "Navigating to login page")
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout })

    log("INFO", "Filling credentials")
    const emailInput = page.locator('input[name="email"], input[type="email"]')
    await emailInput.waitFor({ state: "visible", timeout: 15000 })
    await emailInput.fill(email)
    log("INFO", "Filled email")

    // Check if password field is already visible
    const passwordField = page.locator('input[name="password"], input[type="password"]')
    const isPassVisible = await passwordField.isVisible()

    if (!isPassVisible) {
      log("INFO", "Password field not visible, checking for 'Next' button")
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), #btnNext, #verify_user_btn')
      if (await nextBtn.isVisible()) {
        log("INFO", "Clicking Next button")
        await nextBtn.click()
        log("INFO", "Clicked Next, waiting for password field")
        
        try {
          await passwordField.waitFor({ state: 'visible', timeout: 15000 })
        } catch (e) {
          log("INFO", "Password field not found yet. Checking for a second 'Next' button.")
          const secondNext = page.locator('button:has-text("Next"), button:has-text("Continue"), #btnNext, #verify_user_btn')
          if (await secondNext.isVisible()) {
            log("INFO", "Second Next button found. Clicking it.")
            await secondNext.click()
            await passwordField.waitFor({ state: 'visible', timeout: 15000 })
          } else {
            throw new Error("Could not find password field or second Next button")
          }
        }
      }
    }

    log("INFO", "Attempting to fill password")
    await passwordField.fill(password)
    log("INFO", "Filled password")

    log("INFO", "Submitting login form")
    const submitBtn = page.locator('button[type="submit"], #btnSubmit')
    await submitBtn.click()
    
    log("INFO", "Submitted credentials, checking for 2FA or success")

    // Handle 2FA / Backup Code
    log("INFO", "Checking for 2FA or successful login...")
    try {
      const start2fa = Date.now()
      let is2fa = false
      while (Date.now() - start2fa < 15000) {
        if (page.isClosed()) break
        const isConfirmSignIn = await page.locator('text="Confirm sign-in"').count() > 0
        const isVerification = await page.locator('h1:has-text("Verification"), h2:has-text("Verification")').count() > 0
        const isEnterCode = await page.locator('text="Enter code"').count() > 0
        const isInput = await page.locator('input[name="otp"], input[name="code"], input[name="backupCode"]').count() > 0
        
        if (isConfirmSignIn || isVerification || isEnterCode || isInput) {
          is2fa = true
          break
        }
        if (page.url().includes("/projects") || page.url().includes("/dashboard")) {
          log("INFO", "Login appeared to succeed without 2FA")
          break
        }
        await page.waitForTimeout(1000)
      }

      if (is2fa && !page.isClosed()) {
        log("INFO", "2FA screen detected")
        const backupLink = page.locator('a:has-text("Use a backup code"), button:has-text("Use a backup code")')
        if (await backupLink.isVisible()) {
          log("INFO", "Clicking 'Use a backup code' link")
          await backupLink.click()
          try {
            await page.waitForSelector('input[name="backupCode"], input[id="backupCode"]', { timeout: 10000 })
          } catch (e) {}
        }

        const backupInput = page.locator('input[name="backupCode"], input[id="backupCode"]')
        if (await backupInput.count() > 0) {
          const codeToUse = getBackupCode()
          log("INFO", "Entering backup code", { code: codeToUse })
          await backupInput.first().fill(codeToUse)
          await page.waitForTimeout(1000)

          const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Next"), button[type="submit"]')
          if (await verifyBtn.isVisible()) {
            await verifyBtn.click()
            log("INFO", "Submitted backup code")
          } else {
            await page.keyboard.press('Enter')
          }
          
          log("INFO", "Waiting for navigation after 2FA submission")
          try {
            await page.waitForLoadState("networkidle", { timeout: 15000 })
          } catch (e) {}

          if (page.isClosed()) return

          let currentUrl = page.url()
          if (currentUrl.includes("join-rfp") || await page.locator('text="Save new backup code"').count() > 0) {
            log("INFO", "On new code screen")
            const eyeIcon = page.locator('button[aria-label*="Show"], button[aria-label*="Reveal"], span[class*="eye"], svg[data-icon*="eye"], i[class*="eye"]')
            let newCode = null
            const start = Date.now()
            let clickedEye = false
            while (Date.now() - start < 15000) {
              if (page.isClosed()) break
              let bodyText = await page.innerText("body")
              const codePattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/g
              const matches = [...bodyText.matchAll(codePattern)]
              const candidates = matches.map(m => m[0]).filter(c => c !== codeToUse)
              if (candidates.length > 0) {
                newCode = candidates[0]
                break
              }
              if (!clickedEye && await eyeIcon.count() > 0 && await eyeIcon.first().isVisible()) {
                await eyeIcon.first().click()
                clickedEye = true
              }
              await page.waitForTimeout(1000)
            }
            if (newCode) {
              saveBackupCode(newCode)
              log("INFO", "Captured new backup code", { newCode })
              try {
                const checkbox = page.locator('input[type="checkbox"], label:has-text("I saved my backup code")')
                if (await checkbox.count() > 0) await checkbox.first().click()
              } catch (e) {}
            }
            const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Done"), button:has-text("Next")')
            if (await continueBtn.isVisible()) await continueBtn.click()
          }
        }
      }
    } catch (e) {
      log("WARN", "2FA handling error", { message: e.message })
    }

    if (page.isClosed()) return
    log("INFO", "Waiting for post-login navigation")
    try {
      await page.waitForLoadState("networkidle", { timeout: 30000 })
    } catch (e) {}
  } catch (err) {
    log("ERROR", "Login failed", { message: err.message })
    if (!page.isClosed()) {
      fs.writeFileSync("debug.html", await page.content())
    }
    throw err
  }
}

export async function downloadOpportunityFiles({
  opportunityUrl,
  outputDir,
  headless = true,
  useSession = true,
  navTimeoutMs = 60000,
  waitTimeoutMs = 60000,
}) {
  const email = process.env.BC_EMAIL
  const password = process.env.BC_PASSWORD
  if (!opportunityUrl) return { success: false, error: "Missing opportunityUrl" }
  if (!outputDir) return { success: false, error: "Missing outputDir" }
  if (!email || !password) return { success: false, error: "Missing BC_EMAIL or BC_PASSWORD" }
  ensureDir(outputDir)
  const sessionPath = path.join(process.cwd(), ".bc-session.json")
  const hasSession = useSession && fs.existsSync(sessionPath)
  const userDataDir = path.join(process.cwd(), ".playwright-data")
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ]

  log("INFO", "Start execution", { opportunityUrl, outputDir, headless, useSession })
  
  const browser = await chromium.launch({
    headless,
    args: launchArgs,
    slowMo: headless ? 0 : 500
  })

  let context
  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    
    context = hasSession
      ? await browser.newContext({ acceptDownloads: true, storageState: sessionPath, userAgent })
      : await browser.newContext({ acceptDownloads: true, userAgent })

    const page = await context.newPage()
    
    async function checkForCaptcha(page, contextStr) {
      const captcha = page.locator('iframe[src*="captcha"], iframe[title*="reCAPTCHA"], div:has-text("Security check"), div:has-text("CAPTCHA")')
      const count = await captcha.count()
      if (count > 0) {
        let visible = false
        for (let i = 0; i < count; i++) {
          if (await captcha.nth(i).isVisible()) {
            visible = true
            break
          }
        }
        if (visible) {
          log("WARN", `CAPTCHA/Security check detected during ${contextStr}`)
          return true
        }
      }
      return false
    }

    if (!hasSession) {
      log("INFO", "Logging in")
      await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
      await checkForCaptcha(page, "post-login")
      
      if (useSession) {
        try {
          const state = await context.storageState()
          fs.writeFileSync(sessionPath, JSON.stringify(state))
          log("INFO", "Session persisted", { sessionPath })
        } catch (e) {
          log("WARN", "Could not persist session", { error: e.message })
        }
      }
    }
    
    log("INFO", "Navigating to files page")
    await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })

    if (page.url().includes("edgepilot")) {
        log("INFO", "Detected EdgePilot link, waiting for redirect")
        await checkForCaptcha(page, "EdgePilot redirect")
        const redirectBtn = page.locator('a:has-text("Select this button if you are not automatically redirected")')
        if (await redirectBtn.isVisible()) {
            await redirectBtn.click()
        }
        try {
            await page.waitForURL(url => !url.includes("edgepilot"), { timeout: 30000 })
            log("INFO", "Redirected from EdgePilot")
        } catch (e) {
            if (page.url().includes("edgepilot")) {
                const bcLink = page.locator('a[href*="buildingconnected.com"]')
                 if (await bcLink.count() > 0 && await bcLink.first().isVisible()) {
                      log("INFO", "Found BuildingConnected link on EdgePilot page, clicking it")
                      await bcLink.first().click()
                      await page.waitForLoadState("networkidle")
                 } else {
                      log("WARN", "No BuildingConnected link or button found on EdgePilot page")
                      fs.writeFileSync("debug-edgepilot.html", await page.content())
                 }
            }
        }
    }

    let currentUrl = page.url()
    if (currentUrl.includes("login") || currentUrl.includes("signin") || currentUrl.includes("auth")) {
       log("INFO", "Redirected to auth page, re-attempting login")
       await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
       await checkForCaptcha(page, "re-login")
       
       if (useSession) {
        try {
          const state = await context.storageState()
          fs.writeFileSync(sessionPath, JSON.stringify(state))
          log("INFO", "Session refreshed")
        } catch (e) {}
       }
       await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
       currentUrl = page.url()
    }
    
    if (currentUrl.includes("join-rfp")) {
        log("INFO", "Landed on Join RFP page")
        try {
            const loginLink = page.locator('a:has-text("I’ve used BuildingConnected before"), a:has-text("Sign in"), a:has-text("Log in")')
            if (await loginLink.count() > 0 && await loginLink.first().isVisible()) {
                await loginLink.first().click()
                await page.waitForLoadState("networkidle")
                if (page.url().includes("login") || page.url().includes("signin")) {
                    await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
                }
            }

            const acceptBtn = page.locator('button:has-text("Accept Invitation"), button:has-text("View Opportunity"), button:has-text("View Project"), button:has-text("Join Project"), button:has-text("Continue")')
            if (await acceptBtn.count() > 0 && await acceptBtn.first().isVisible()) {
                await acceptBtn.first().click()
                await page.waitForLoadState("networkidle", { timeout: 30000 })
            }
        } catch (e) {}
    }

    let filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
    try {
      await filesReady.waitFor({ state: 'visible', timeout: 10000 })
    } catch {
      log("INFO", "Searching for Files tab")
      const filesTab = page.locator('a:has-text("Files"), button:has-text("Files"), div[role="tab"]:has-text("Files"), [data-test="files-tab"]')
      const count = await filesTab.count()
      if (count > 0) {
        for (let i = 0; i < count; i++) {
             if (await filesTab.nth(i).isVisible()) {
                 await filesTab.nth(i).click()
                 await page.waitForTimeout(2000)
                 break
             }
        }
      }
      filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
      try {
          await filesReady.waitFor({ state: 'visible', timeout: 15000 })
      } catch (e) {
          const docTab = page.locator('a:has-text("Documents"), [data-test="documents-tab"]')
          if (await docTab.count() > 0 && await docTab.first().isVisible()) {
              await docTab.first().click()
              await page.waitForTimeout(2000)
          }
          filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
          try {
              await filesReady.waitFor({ state: 'visible', timeout: 10000 })
          } catch (e2) {
              const dlIcon = page.locator('button i.icon-download, button svg[data-icon="download"], button[aria-label*="Download"]')
              if (await dlIcon.count() > 0 && await dlIcon.first().isVisible()) {
                  filesReady = dlIcon.first()
              } else {
                  fs.writeFileSync("debug-files-page.html", await page.content())
                  throw e2
              }
          }
        }
    }
    
    log("INFO", "Triggering download")
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: waitTimeoutMs }),
      filesReady.click({ timeout: waitTimeoutMs }),
    ])
    const suggested = download.suggestedFilename()
    const finalPath = path.join(outputDir, suggested)
    await download.saveAs(finalPath)
    log("INFO", "Download complete", { path: finalPath })
    return { success: true, downloadedFiles: [finalPath], newBackupCode: getBackupCode() }
  } catch (err) {
    log("ERROR", "Automation failed", { message: err.message })
    return { success: false, error: err.message }
  } finally {
    log("INFO", "Finished execution")
  }
}
