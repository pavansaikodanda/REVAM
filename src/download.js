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
    const takeShot = async (name) => {
      try {
        const shotPath = path.join(outputDir, `${name}.png`)
        await page.screenshot({ path: shotPath, fullPage: true })
        log("INFO", "Saved screenshot", { path: shotPath })
      } catch (e) {}
    }
    const clickVisible = async (locator, shotName) => {
      if (await locator.count() > 0 && await locator.first().isVisible()) {
        await locator.first().scrollIntoViewIfNeeded()
        await locator.first().click({ timeout: 10000 })
        if (shotName) await takeShot(shotName)
        return true
      }
      return false
    }

    log("INFO", "Filling email")
    const emailInput = page.locator('input[name="email"], input[type="email"]')
    await emailInput.waitFor({ state: "visible", timeout: 30000 })
    await emailInput.fill(email)
    await page.waitForTimeout(1000)
    await takeShot("01_email_filled")

    log("INFO", "Step 2: Advancing past email screen")
    const nextBtn = page.getByRole("button", { name: "Next", exact: true })
    const nextBtnUpper = page.getByRole("button", { name: "NEXT", exact: true })
    const continueBtn = page.getByRole("button", { name: "Continue", exact: true })
    const signInBtn = page.getByRole("button", { name: "Sign in", exact: true })
    const signInBtnUpper = page.getByRole("button", { name: "Sign In", exact: true })
    const passwordField = page.locator('input[name="password"], input[type="password"]')
    const startAdvance = Date.now()
    let advanced = false
    while (Date.now() - startAdvance < 30000) {
      if (page.isClosed()) break
      if (await passwordField.isVisible()) {
        advanced = true
        break
      }
      if (await clickVisible(signInBtn, "02_after_sign_in") || await clickVisible(signInBtnUpper, "02_after_sign_in")) {
        await page.waitForTimeout(3000)
      } else if (await clickVisible(nextBtn, "02_after_next") || await clickVisible(nextBtnUpper, "02_after_next") || await clickVisible(continueBtn, "02_after_next")) {
        await page.waitForTimeout(3000)
      } else {
        await emailInput.press("Enter")
        await page.waitForTimeout(2000)
      }
    }
    if (!advanced && !page.isClosed()) {
      throw new Error("Password field never appeared")
    }

    log("INFO", "Step 3: Waiting for password and Sign In")
    await passwordField.waitFor({ state: "visible", timeout: 30000 })

    await passwordField.fill(password)
    await page.waitForTimeout(1000)
    await takeShot("03_password_filled")

    const submitBtn = page.getByRole("button", { name: "Sign in", exact: true })
    const submitBtnUpper = page.getByRole("button", { name: "Sign In", exact: true })
    if (!(await clickVisible(submitBtn)) && !(await clickVisible(submitBtnUpper))) {
      const fallbackSubmit = page.locator('button[type="submit"], #btnSubmit')
      await fallbackSubmit.first().click()
    }
    await page.waitForTimeout(3000)
    await takeShot("04_after_sign_in")
    
    log("INFO", "Step 4: Checking for 2FA screen and clicking 'Use a backup code'")
    const twofaStart = Date.now()
    let found2fa = false
    while (Date.now() - twofaStart < 30000) {
      if (page.isClosed()) break
      const texts = ["Confirm sign-in", "Verification", "Enter code", "Enter backup code"]
      for (const t of texts) {
        if (await page.getByText(t, { exact: true }).count() > 0) {
          found2fa = true
          break
        }
      }
      if (found2fa || await page.locator('input[type="tel"]').count() > 0) {
        found2fa = true
        break
      }
      await page.waitForTimeout(2000)
    }

    let completed2fa = false
    if (found2fa && !page.isClosed()) {
      const backupLink = page.getByRole("link", { name: "Use a backup code", exact: true })
      const backupButton = page.getByRole("button", { name: "Use a backup code", exact: true })
      if (await clickVisible(backupLink) || await clickVisible(backupButton)) {
        log("INFO", "Clicking 'Use a backup code' link")
        await page.waitForTimeout(5000)
        await takeShot("05_after_backup_link")
      }

      const backupInputs = page.locator('input[type="tel"], input[type="text"], input[name="code"], input[id="code"], input[name="backupCode"], input[id="backupCode"]')
      await backupInputs.first().waitFor({ state: "visible", timeout: 30000 })
      if (await backupInputs.count() > 0) {
        let code = getBackupCode()
        log("INFO", "Entering backup code", { code })
        const cleanCode = code.replace("-", "")
        const inputCount = await backupInputs.count()
        if (inputCount > 1) {
          for (let i = 0; i < Math.min(inputCount, cleanCode.length); i++) {
            await backupInputs.nth(i).focus()
            await backupInputs.nth(i).fill(cleanCode[i])
            await page.waitForTimeout(150)
          }
        } else {
          await backupInputs.first().focus()
          await page.keyboard.type(cleanCode, { delay: 250 })
        }
        await page.waitForTimeout(3000)
        await takeShot("06_backup_code_typed")

        const next2fa = page.getByRole("button", { name: "Next", exact: true })
        const verifyBtn = page.getByRole("button", { name: "Verify", exact: true })
        const submitBtn2 = page.getByRole("button", { name: "Submit", exact: true })
        if (!(await clickVisible(next2fa)) && !(await clickVisible(verifyBtn)) && !(await clickVisible(submitBtn2))) {
          await page.keyboard.press("Enter")
        }
        
        log("INFO", "Step 5: Waiting for post-2FA screen (capture new code and Continue)")
        await page.waitForTimeout(10000)
        await takeShot("07_post_2fa")

        log("INFO", "Scanning for new backup code")
        const codePattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/g
        const bodyText = await page.innerText("body")
        const matches = [...bodyText.matchAll(codePattern)]
        const candidates = matches.map(m => m[0]).filter(c => c !== code)
        
        if (candidates.length > 0) {
          const newCode = candidates[0]
          saveBackupCode(newCode)
          log("INFO", "Captured new backup code", { newCode })
          await takeShot("08_new_backup_code")
          
          const checkbox = page.locator('input[type="checkbox"]')
          if (await checkbox.count() > 0) {
            await checkbox.first().click()
          }
          
          const continueBtn2 = page.getByRole("button", { name: "Continue", exact: true })
          const doneBtn = page.getByRole("button", { name: "Done", exact: true })
          const nextBtn2 = page.getByRole("button", { name: "Next", exact: true })
          if (!(await clickVisible(continueBtn2)) && !(await clickVisible(doneBtn)) && !(await clickVisible(nextBtn2))) {
            await page.keyboard.press("Enter")
          }
          await page.waitForTimeout(5000)
          await takeShot("09_after_continue")
          completed2fa = true
        }
      }
    }
    return { completed2fa }
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
  let page
  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: launchArgs,
      acceptDownloads: true,
      userAgent,
      viewport: { width: 1280, height: 720 },
      slowMo: headless ? 0 : 200,
      timeout: 120000 // 2 minute launch timeout
    })

    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()
    
    page.on('close', () => log("WARN", "Browser page closed unexpectedly"));
    page.on('crash', () => log("ERROR", "Browser page crashed"));
    
    async function checkForCaptcha(page, contextStr) {
      const captchaFrames = page.locator('iframe[title="reCAPTCHA"]')
      const count = await captchaFrames.count()
      if (count > 0) {
        let visible = false
        for (let i = 0; i < count; i++) {
          if (await captchaFrames.nth(i).isVisible()) {
            visible = true
            break
          }
        }
        if (visible) {
          log("WARN", `CAPTCHA/Security check detected during ${contextStr}`)
          return true
        }
      }
      if (await page.getByText("Security check", { exact: true }).count() > 0) return true
      if (await page.getByText("CAPTCHA", { exact: true }).count() > 0) return true
      return false
    }

    log("INFO", "Navigating to opportunity page")
    await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })

    if (page.url().includes("edgepilot")) {
        log("INFO", "Detected EdgePilot link, waiting for redirect")
        await checkForCaptcha(page, "EdgePilot redirect")
        const redirectBtn = page.getByRole("button", { name: "Select this button if you are not automatically redirected", exact: true })
        const redirectLink = page.getByRole("link", { name: "Select this button if you are not automatically redirected", exact: true })
        if ((await redirectBtn.count() > 0 && await redirectBtn.first().isVisible()) || (await redirectLink.count() > 0 && await redirectLink.first().isVisible())) {
            log("INFO", "Clicking EdgePilot redirect button")
            if (await redirectBtn.count() > 0 && await redirectBtn.first().isVisible()) {
              await redirectBtn.first().click()
            } else {
              await redirectLink.first().click()
            }
        }
        try {
            await page.waitForURL(url => !url.includes("edgepilot"), { timeout: 30000 })
            log("INFO", "Redirected from EdgePilot")
        } catch (e) {
            if (page.url().includes("edgepilot")) {
                log("WARN", "No BuildingConnected redirect")
                fs.writeFileSync("debug-edgepilot.html", await page.content())
            }
        }
    }

    try {
      const urlObj = new URL(page.url())
      if (urlObj.host === "link.edgepilot.com") {
        const target = urlObj.searchParams.get("u")
        if (target) {
          const decodedTarget = decodeURIComponent(target)
          log("INFO", "Navigating to decoded EdgePilot target")
          await page.goto(decodedTarget, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
        }
      }
    } catch (e) {}

    let currentUrl = page.url()
    let loggedIn = false
    const isLoginScreen = async () => {
      const emailField = page.locator('input[type="email"], input[name="email"]')
      return (await emailField.count() > 0 && await emailField.first().isVisible())
    }
    const isJoinRfp = async () => {
      try {
        const urlObj = new URL(page.url())
        return urlObj.pathname.startsWith("/_/join-rfp")
      } catch (e) {
        return false
      }
    }
    const waitForJoinRfpOrLogin = async () => {
      const start = Date.now()
      while (Date.now() - start < 30000) {
        if (await isLoginScreen()) return
        if (await isJoinRfp()) return
        await page.waitForTimeout(1000)
      }
    }
    await waitForJoinRfpOrLogin()
    currentUrl = page.url()
    
    if (currentUrl.includes("login") || currentUrl.includes("signin") || currentUrl.includes("auth") || await isLoginScreen()) {
      log("INFO", "Login screen detected, performing login")
      const loginResult = await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
      loggedIn = loginResult && loginResult.completed2fa
      await checkForCaptcha(page, "post-login")
      if (useSession) {
        try {
          const state = await context.storageState()
          fs.writeFileSync(sessionPath, JSON.stringify(state))
          log("INFO", "Session persisted", { sessionPath })
        } catch (e) {}
      }
      if (!loggedIn) {
        throw new Error("Backup code flow did not complete")
      }
      log("INFO", "Returning to opportunity page after login")
      await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
      currentUrl = page.url()
    }
    
    if (currentUrl.includes("join-rfp") || await page.getByRole("button", { name: "Accept Invitation", exact: true }).count() > 0 || await page.getByRole("button", { name: "View Opportunity", exact: true }).count() > 0 || await page.getByRole("button", { name: "View Project", exact: true }).count() > 0 || await page.getByRole("button", { name: "Join Project", exact: true }).count() > 0) {
        log("INFO", "Landed on Join RFP or Invitation page")
        try {
            const usedBeforeBtn = page.getByRole("button", { name: "I’ve used BuildingConnected before", exact: true })
            const loginLink = page.getByRole("link", { name: "I’ve used BuildingConnected before", exact: true })
            if (await usedBeforeBtn.count() > 0 && await usedBeforeBtn.first().isVisible()) {
                log("INFO", "Clicking I’ve used BuildingConnected before")
                await usedBeforeBtn.first().click()
                await page.waitForLoadState("networkidle")
            }
            if (await loginLink.count() > 0 && await loginLink.first().isVisible()) {
                log("INFO", "Clicking login link on Join RFP page")
                await loginLink.first().click()
                await page.waitForLoadState("networkidle")
                const loginResult = await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
                loggedIn = loginResult && loginResult.completed2fa
                await checkForCaptcha(page, "post-login")
                if (useSession) {
                  try {
                    const state = await context.storageState()
                    fs.writeFileSync(sessionPath, JSON.stringify(state))
                    log("INFO", "Session persisted", { sessionPath })
                  } catch (e) {}
                }
                if (!loggedIn) {
                  throw new Error("Backup code flow did not complete")
                }
                log("INFO", "Returning to opportunity page after Join RFP login")
                await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
            }
            if (!loggedIn && await isLoginScreen()) {
              log("INFO", "Join RFP login form detected, performing login")
              const loginResult = await performLogin(page, email, password, navTimeoutMs, headless, outputDir)
              loggedIn = loginResult && loginResult.completed2fa
              await checkForCaptcha(page, "post-login")
              if (useSession) {
                try {
                  const state = await context.storageState()
                  fs.writeFileSync(sessionPath, JSON.stringify(state))
                  log("INFO", "Session persisted", { sessionPath })
                } catch (e) {}
              }
              if (!loggedIn) {
                throw new Error("Backup code flow did not complete")
              }
              log("INFO", "Returning to opportunity page after Join RFP login")
              await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
            }

            const acceptInvitation = page.getByRole("button", { name: "Accept Invitation", exact: true })
            const viewOpportunity = page.getByRole("button", { name: "View Opportunity", exact: true })
            const viewProject = page.getByRole("button", { name: "View Project", exact: true })
            const joinProject = page.getByRole("button", { name: "Join Project", exact: true })
            const continueBtn = page.getByRole("button", { name: "Continue", exact: true })
            const acceptBtn = page.getByRole("button", { name: "Accept", exact: true })
            if (await acceptInvitation.count() > 0 && await acceptInvitation.first().isVisible()) {
              await acceptInvitation.first().click()
            } else if (await viewOpportunity.count() > 0 && await viewOpportunity.first().isVisible()) {
              await viewOpportunity.first().click()
            } else if (await viewProject.count() > 0 && await viewProject.first().isVisible()) {
              await viewProject.first().click()
            } else if (await joinProject.count() > 0 && await joinProject.first().isVisible()) {
              await joinProject.first().click()
            } else if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
              await continueBtn.first().click()
            } else if (await acceptBtn.count() > 0 && await acceptBtn.first().isVisible()) {
              await acceptBtn.first().click()
            }
            await page.waitForLoadState("networkidle", { timeout: 30000 })
            await page.waitForTimeout(5000)
        } catch (e) {
            log("WARN", "Error handling Join RFP page", { message: e.message })
        }
    }

    if (!loggedIn) {
      log("ERROR", "Login did not complete before Files step")
      throw new Error("Login did not complete before Files step")
    }

    const overviewTab = page.getByRole("tab", { name: "Overview", exact: true })
    const filesTab = page.getByRole("tab", { name: "Files", exact: true })
    const messagesTab = page.getByRole("tab", { name: "Messages", exact: true })
    const bidFormTab = page.getByRole("tab", { name: "Bid Form", exact: true })
    const startTabs = Date.now()
    while (Date.now() - startTabs < 30000) {
      if ((await overviewTab.count() > 0 && await overviewTab.first().isVisible()) ||
          (await filesTab.count() > 0 && await filesTab.first().isVisible()) ||
          (await messagesTab.count() > 0 && await messagesTab.first().isVisible()) ||
          (await bidFormTab.count() > 0 && await bidFormTab.first().isVisible())) {
        break
      }
      await page.waitForTimeout(500)
    }

    log("INFO", "Step 6: Clicking on the Files tab")
    const filesTabBtn = page.getByRole("button", { name: "Files", exact: true })
    const filesTabLink = page.getByRole("link", { name: "Files", exact: true })
    const startFilesTab = Date.now()
    while (Date.now() - startFilesTab < 30000) {
      if (await filesTab.count() > 0 && await filesTab.first().isVisible()) {
        await filesTab.first().click()
        break
      }
      if (await filesTabBtn.count() > 0 && await filesTabBtn.first().isVisible()) {
        await filesTabBtn.first().click()
        break
      }
      if (await filesTabLink.count() > 0 && await filesTabLink.first().isVisible()) {
        await filesTabLink.first().click()
        break
      }
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(3000)

    log("INFO", "Step 7: Clicking on Download All button")
    const filesReady = page.getByRole("button", { name: "Download All", exact: true })
    await filesReady.first().waitFor({ state: 'visible', timeout: 30000 })
    
    log("INFO", "Triggering download")
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: waitTimeoutMs }),
      filesReady.first().click({ timeout: waitTimeoutMs }),
    ])
    const suggested = download.suggestedFilename()
    const finalPath = path.join(outputDir, suggested)
    await download.saveAs(finalPath)
    log("INFO", "Download complete", { path: finalPath })

    try {
      if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true })
      if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true })
      log("INFO", "Cleared session data")
    } catch (e) {
      log("WARN", "Failed to clear session data", { message: e.message })
    }
    
    if (!headless && page && !page.isClosed()) {
      log("INFO", "Keeping browser open for 5 minutes so you can see the result...")
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
    if (headless) {
        if (context) await context.close()
    }
    log("INFO", "Finished execution")
  }
}
