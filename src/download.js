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
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 })

    log("INFO", "Filling email")
    const emailInput = page.locator('input[name="email"], input[type="email"]')
    await emailInput.waitFor({ state: "visible", timeout: 30000 })
    await emailInput.fill(email)

    log("INFO", "Checking for Next button")
    const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), #btnNext, #verify_user_btn')
    if (await nextBtn.isVisible()) {
      await nextBtn.click()
      await page.waitForTimeout(3000)
    }

    log("INFO", "Waiting for password field")
    const passwordField = page.locator('input[name="password"], input[type="password"]')
    
    let passVisible = false
    const passStart = Date.now()
    while (Date.now() - passStart < 30000) {
      if (page.isClosed()) break
      if (await passwordField.isVisible()) {
        passVisible = true
        break
      }
      const secondNext = page.locator('button:has-text("Next"), button:has-text("Continue"), #btnNext, #verify_user_btn')
      if (await secondNext.isVisible()) {
        log("INFO", "Clicking second Next button")
        await secondNext.click()
        await page.waitForTimeout(3000)
      }
      await page.waitForTimeout(2000)
    }

    if (!passVisible && !page.isClosed()) {
        throw new Error("Password field never appeared")
    }

    log("INFO", "Filling password")
    await passwordField.fill(password)
    await page.waitForTimeout(1000)

    log("INFO", "Submitting login")
    const submitBtn = page.locator('button[type="submit"], #btnSubmit')
    await submitBtn.click()
    
    log("INFO", "Waiting for 2FA screen")
    const twofaStart = Date.now()
    let found2fa = false
    while (Date.now() - twofaStart < 30000) {
      if (page.isClosed()) break
      const texts = ["Confirm sign-in", "Verification", "Enter code", "Enter backup code"]
      for (const t of texts) {
        if (await page.locator(`text="${t}"`).count() > 0) {
          found2fa = true
          break
        }
      }
      if (found2fa || await page.locator('input[type="tel"]').count() > 0 || await page.locator('input[aria-label*="code"]').count() > 0) {
        found2fa = true
        break
      }
      await page.waitForTimeout(2000)
    }

    if (found2fa && !page.isClosed()) {
      log("INFO", "2FA Screen Detected")
      
      const backupLink = page.locator('a:has-text("Use a backup code"), button:has-text("Use a backup code"), text="Use backup code"')
      if (await backupLink.isVisible()) {
        log("INFO", "Clicking backup link")
        await backupLink.click()
        await page.waitForTimeout(5000)
      }

      const backupInput = page.locator('input[type="tel"], input[aria-label*="code"], input[name*="code"], input[id*="code"]')
      if (await backupInput.count() > 0) {
        let code = getBackupCode()
        log("INFO", "Entering code character by character", { code })
        await backupInput.first().focus()
        const cleanCode = code.replace("-", "")
        await page.keyboard.type(cleanCode, { delay: 250 })
        await page.waitForTimeout(3000)

        const next = page.locator('button:has-text("Next"), button:has-text("Verify"), button:has-text("Submit"), button[type="submit"]')
        if (await next.isVisible()) {
          log("INFO", "Clicking Next on 2FA")
          await next.click()
        } else {
          log("INFO", "Pressing Enter on 2FA")
          await page.keyboard.press("Enter")
        }
        
        log("INFO", "Waiting for post-2FA screen (new code capture)")
        await page.waitForTimeout(10000)

        log("INFO", "Scanning for new backup code")
        const codePattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/g
        const bodyText = await page.innerText("body")
        const matches = [...bodyText.matchAll(codePattern)]
        const candidates = matches.map(m => m[0]).filter(c => c !== code)
        
        if (candidates.length > 0) {
          const newCode = candidates[0]
          saveBackupCode(newCode)
          log("INFO", "SUCCESS: Captured new backup code", { newCode })
          
          const checkbox = page.locator('input[type="checkbox"], label:has-text("I saved my backup code")')
          if (await checkbox.count() > 0) await checkbox.first().click()
          const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Done"), button:has-text("Next")')
          if (await continueBtn.isVisible()) await continueBtn.click()
          await page.waitForTimeout(5000)
        }
      }
    }
  } catch (err) {
    log("ERROR", "performLogin failed", { message: err.message })
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
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu'
  ]

  log("INFO", "Start execution", { opportunityUrl, outputDir, headless, useSession })
  
  let context
  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    
    // Attempting launchPersistentContext for maximum stability in sandbox
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: launchArgs,
      acceptDownloads: true,
      userAgent,
      viewport: { width: 1280, height: 720 },
      slowMo: headless ? 0 : 200,
      timeout: 120000 // 2 minute launch timeout
    })

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()
    
    // Monitor for close/crash
    page.on('close', () => log("WARN", "Browser page closed unexpectedly"));
    page.on('crash', () => log("ERROR", "Browser page crashed"));
    
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
        const redirectBtn = page.locator('button:has-text("Select this button if you are not automatically redirected"), a:has-text("Select this button if you are not automatically redirected")')
        if (await redirectBtn.count() > 0 && await redirectBtn.first().isVisible()) {
            log("INFO", "Clicking EdgePilot redirect button")
            await redirectBtn.first().click()
        }
        try {
            await page.waitForURL(url => !url.includes("edgepilot"), { timeout: 30000 })
            log("INFO", "Redirected from EdgePilot")
        } catch (e) {
            if (page.url().includes("edgepilot")) {
                 const bcLink = page.locator('a[href*="buildingconnected.com"], button[type="submit"]')
                 if (await bcLink.count() > 0 && await bcLink.first().isVisible()) {
                      log("INFO", "Found BuildingConnected link/button on EdgePilot page, clicking it")
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
    
    if (currentUrl.includes("join-rfp") || await page.locator('button:has-text("Accept Invitation"), button:has-text("View Opportunity"), button:has-text("View Project"), button:has-text("Join Project")').count() > 0) {
        log("INFO", "Landed on Join RFP or Invitation page")
        try {
            const loginLink = page.locator('a:has-text("I’ve used BuildingConnected before"), a:has-text("Sign in"), a:has-text("Log in"), a:has-text("Already have an account")')
            if (await loginLink.count() > 0 && await loginLink.first().isVisible()) {
                log("INFO", "Clicking login link on Join RFP page")
                await loginLink.first().click()
                await page.waitForLoadState("networkidle")
                if (page.url().includes("login") || page.url().includes("signin")) {
                    await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
                }
            }

            const acceptBtn = page.locator('button:has-text("Accept Invitation"), button:has-text("View Opportunity"), button:has-text("View Project"), button:has-text("Join Project"), button:has-text("Continue"), button:has-text("Accept")')
            if (await acceptBtn.count() > 0) {
                await acceptBtn.first().waitFor({ state: "visible", timeout: 15000 })
                log("INFO", "Clicking Accept/Join button")
                await acceptBtn.first().click()
                await page.waitForLoadState("networkidle", { timeout: 30000 })
                await page.waitForTimeout(5000)
            }
        } catch (e) {
            log("WARN", "Error handling Join RFP page", { message: e.message })
        }
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
    
    if (!headless) {
      log("INFO", "Keeping browser open for 5 minutes so you can see the result...")
      await page.waitForTimeout(300000)
    }
    
    return { success: true, downloadedFiles: [finalPath], newBackupCode: getBackupCode() }
  } catch (err) {
    log("ERROR", "Automation failed", { message: err.message })
    if (!headless) {
        log("INFO", "Error occurred. Keeping browser open for 5 minutes for debugging...")
        await page.waitForTimeout(300000)
    }
    return { success: false, error: err.message }
  } finally {
    if (headless) {
        if (context) await context.close()
    }
    log("INFO", "Finished execution")
  }
}
