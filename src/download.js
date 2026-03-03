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

async function performLogin(page, email, password, timeout, headless) {
  try {
    log("INFO", "Navigating to login page")
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout })
    const emailInput = page.locator('input[name="email"], input[id="userName"]')
    const passwordInput = page.locator('input[name="password"], input[id="password"], input[type="password"]')
    const submitBtn = page.locator('button[type="submit"], #btnSubmit')
    
    try {
      await emailInput.waitFor({ state: "visible", timeout: 10000 })
    } catch (e) {
      log("WARN", "Login form not detected immediately")
    }

    const atLogin = await emailInput.count()
    if (atLogin > 0) {
      // Handle potential cookie banner
      try {
          const cookieBtn = page.locator('button:has-text("Accept All"), button:has-text("I Accept"), #onetrust-accept-btn-handler')
          if (await cookieBtn.count() > 0 && await cookieBtn.isVisible()) {
              log("INFO", "Clicking cookie banner")
              await cookieBtn.click({ timeout: 5000 })
          }
      } catch (e) {}

      log("INFO", "Filling credentials")
      await emailInput.fill(email, { timeout })
      log("INFO", "Filled email")

      // Handle 2-step login (Autodesk ID)
      if (!(await passwordInput.isVisible())) {
          log("INFO", "Password field not visible, checking for 'Next' button")
          const nextBtn = page.locator('button:has-text("Next"), #verify_user_btn')
          if (await nextBtn.isVisible()) {
              log("INFO", "Clicking Next button")
              await nextBtn.click()
              log("INFO", "Clicked Next, waiting for password field")
              
              try {
                // Wait for password field OR an error
                log("INFO", "Starting Promise.race for password/error")
                await Promise.race([
                    passwordInput.waitFor({ state: "visible", timeout: 10000 }).then(() => log("INFO", "Race resolved: password visible")),
                    page.locator('.error-message, .alert-danger').waitFor({ state: "visible", timeout: 10000 }).then(() => log("INFO", "Race resolved: error visible"))
                ])
                log("INFO", "Promise.race completed")
              } catch (e) {
                 log("INFO", "Password field not found yet (Promise.race rejected). Checking for a second 'Next' button.")
                 if (await nextBtn.isVisible()) {
                     log("INFO", "Second Next button found. Clicking it.")
                     await nextBtn.click()
                     await page.waitForTimeout(1000)
                     try {
                         await passwordInput.waitFor({ state: "visible", timeout: 20000 })
                     } catch (e2) {
                         // Fall through to stall logic
                         log("WARN", "Password field did not appear after second Next")
                         throw e2 
                     }
                 } else {
                     log("WARN", "Second Next button not found, throwing original error")
                     throw e
                 }
              }
            } else {
              log("INFO", "Next button not found, trying Enter key on email")
             await emailInput.press("Enter")
             try {
                await passwordInput.waitFor({ state: "visible", timeout: 5000 })
             } catch (e) {
                 log("WARN", "Enter key did not reveal password field")
             }
          }
      }

      log("INFO", "Attempting to fill password")
      await passwordInput.fill(password, { timeout })
      log("INFO", "Filled password")
      log("INFO", "Submitting login form")
      await submitBtn.click({ timeout })
      log("INFO", "Submitted credentials, checking for 2FA")

      // Handle 2FA / Backup Code
      log("INFO", "Checking for 2FA or successful login...")
      try {
        // Wait up to 15 seconds for 2FA or success
         const start2fa = Date.now()
         let is2fa = false
         while (Date.now() - start2fa < 15000) {
              log("INFO", "Polling for 2FA or success...")
              // Check for 2FA elements individually to avoid selector parsing errors
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

          if (is2fa) {
              log("INFO", "2FA screen detected")
              
              // Explicitly look for "Use a backup code" link as requested by user
               const backupLink = page.locator('a:has-text("Use a backup code"), button:has-text("Use a backup code")')
               if (await backupLink.isVisible()) {
                    log("INFO", "Clicking 'Use a backup code' link")
                    await backupLink.click()
                    log("INFO", "Waiting for backup code input to appear...")
                    try {
                        await page.waitForSelector('input[name="backupCode"], input[id="backupCode"]', { timeout: 10000 })
                    } catch (e) {
                        log("WARN", "Backup code input did not appear within 10s")
                    }
               }
 
               // Check for "Use another method" if backup code input is not visible
              let backupInput = page.locator('input[name="backupCode"], input[id="backupCode"]')
              if (!(await backupInput.isVisible())) {
                  const anotherMethod = page.locator('button:has-text("Use another method"), a:has-text("Use another method")')
                if (await anotherMethod.isVisible()) {
                    log("INFO", "Clicking 'Use another method'")
                    await anotherMethod.click()
                    await page.waitForTimeout(1000)
                }
                
                const backupLink = page.locator('button:has-text("backup code"), a:has-text("backup code")')
                if (await backupLink.isVisible()) {
                    log("INFO", "Selecting backup code option")
                    await backupLink.click()
                    await page.waitForTimeout(1000)
                }
            }

            // Re-query for inputs (could be one or split)
            backupInput = page.locator('input[name="backupCode"], input[id="backupCode"]')
            if (await backupInput.count() === 0) {
                 // Try finding inputs by type if specific name not found
                 const genericInputs = page.locator('input[type="text"], input[type="tel"]')
                 // Filter for visible inputs - create a new locator for visible ones
                 const visibleInputs = []
                 const count = await genericInputs.count()
                 for (let i = 0; i < count; i++) {
                     if (await genericInputs.nth(i).isVisible()) {
                         visibleInputs.push(genericInputs.nth(i))
                     }
                 }
                 if (visibleInputs.length > 0) {
                     // Use the first visible input's selector or just use the nth locator logic
                     // Better to just use the generic locator and filter by visibility in the logic below
                     backupInput = genericInputs
                 }
            }

            const inputCount = await backupInput.count()
            if (inputCount > 0) {
                const codeToUse = getBackupCode()
                log("INFO", "Entering backup code", { code: codeToUse, inputCount })
                
                // Detect input style
                if (inputCount >= 8) {
                     log("INFO", "Detected individual character inputs")
                     const cleanCode = codeToUse.replace('-', '') // Remove hyphen
                     for (let i = 0; i < Math.min(inputCount, cleanCode.length); i++) {
                         if (await backupInput.nth(i).isVisible()) {
                             await backupInput.nth(i).fill(cleanCode[i])
                             await page.waitForTimeout(100)
                         }
                     }
                } else if (inputCount >= 2) {
                     log("INFO", "Detected split input fields")
                     const parts = codeToUse.split('-')
                     if (parts.length === 2) {
                         // Type slowly into first box
                         if (await backupInput.nth(0).isVisible()) {
                             await backupInput.nth(0).focus()
                             await backupInput.nth(0).fill("") // Clear first
                             await page.keyboard.type(parts[0], { delay: 150 })
                             await page.waitForTimeout(500)
                         }
                         
                         // Type slowly into second box
                         if (await backupInput.nth(1).isVisible()) {
                             await backupInput.nth(1).focus()
                             await backupInput.nth(1).fill("") // Clear first
                             await page.keyboard.type(parts[1], { delay: 150 })
                         }
                     } else {
                         if (await backupInput.first().isVisible()) {
                             await backupInput.first().fill(codeToUse)
                         }
                     }
                } else {
                    if (await backupInput.first().isVisible()) {
                        await backupInput.first().focus()
                        await page.keyboard.type(codeToUse, { delay: 100 })
                    }
                }
                
                log("INFO", "Waiting for validation state update...")
                await page.waitForTimeout(2000) // Wait for "Code is required" to disappear

                const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Next"), button[type="submit"]')
                if (await verifyBtn.isVisible()) {
                    await verifyBtn.click()
                    log("INFO", "Submitted backup code")
                } else {
                     log("WARN", "Verify/Next button not found")
                     await page.keyboard.press('Enter')
                }
                
                // Wait for new backup code generation
                log("INFO", "Waiting for new backup code screen")
                try {
                    await page.waitForSelector('text="Save new backup code"', { timeout: 30000 })
                    log("INFO", "New backup code screen appeared")
                } catch (e) {
                    log("WARN", "Did not see 'Save new backup code' header, checking if we skipped it")
                }

                // Attempt to find and click eye icon if code is hidden or just to ensure visibility
                const eyeIcon = page.locator('button[aria-label*="Show"], button[aria-label*="Reveal"], span[class*="eye"], svg[data-icon*="eye"], i[class*="eye"]')
                
                let newCode = null
                const start = Date.now()
                let clickedEye = false
                
                while (Date.now() - start < 30000) { // 30s wait
                    const bodyText = await page.innerText("body")
                    const codePattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/g
                    const matches = [...bodyText.matchAll(codePattern)]
                    
                    // Filter out the old code
                    const candidates = matches.map(m => m[0]).filter(c => c !== codeToUse)
                    
                    if (candidates.length > 0) {
                        newCode = candidates[0]
                        break
                    }
                    
                    // If no code found, try clicking eye if we haven't yet
                    if (!clickedEye && await eyeIcon.count() > 0 && await eyeIcon.first().isVisible()) {
                        log("INFO", "Code not found yet or trying to reveal, clicking eye icon")
                        await eyeIcon.first().click()
                        clickedEye = true
                        await page.waitForTimeout(1000)
                        continue
                    }
                    
                    await page.waitForTimeout(1000)
                }
                
                if (newCode) {
                    saveBackupCode(newCode)
                    log("INFO", "Captured and saved new backup code", { newCode })
                    
                    // Click "I saved my backup code" checkbox
                    log("INFO", "Selecting 'I saved my backup code' checkbox")
                    const savedCheckbox = page.locator('input[type="checkbox"]')
                    if (await savedCheckbox.count() > 0) {
                         if (await savedCheckbox.first().isVisible()) {
                             await savedCheckbox.first().check()
                         } else {
                             // Try clicking the label if checkbox is hidden
                             await page.locator('label:has-text("I saved my backup code")').click()
                         }
                    } else {
                         // Try generic click on the text
                         const labelText = page.locator('text="I saved my backup code"')
                         if (await labelText.isVisible()) {
                             await labelText.click()
                         } else {
                             log("WARN", "Checkbox not found via standard selectors")
                         }
                    }
                    await page.waitForTimeout(500)

                } else {
                    log("WARN", "Could not identify new backup code.")
                    fs.writeFileSync("debug-new-code.html", await page.content())
                }

                const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Done"), button:has-text("Next")')
                if (await continueBtn.isVisible()) {
                    await continueBtn.click()
                }
            }
        }
      } catch (e) {
          log("WARN", "2FA handling encountered an error", { message: e.message })
      }

      log("INFO", "Waiting for post-login navigation")
      try {
          await page.waitForLoadState("networkidle", { timeout: 30000 })
      } catch (e) {
          log("WARN", "Network idle timeout, proceeding anyway")
      }
    } else {
      log("INFO", "Login form not found")
    }
  } catch (err) {
    log("ERROR", "Login failed", { message: err.message })
    fs.writeFileSync("debug.html", await page.content())
    log("INFO", "Dumped page content to debug.html")
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
  log("INFO", "Start execution", { opportunityUrl, outputDir, headless, useSession })
  const browser = await chromium.launch({
    headless,
    args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
    ]
  })
  let context
  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    context = hasSession
      ? await browser.newContext({ acceptDownloads: true, storageState: sessionPath, userAgent })
      : await browser.newContext({ acceptDownloads: true, userAgent })
    const page = await context.newPage()
    // Generic CAPTCHA / Security check detector
    async function checkForCaptcha(page, contextStr) {
        try {
            // Check for visibility to avoid false positives from hidden iframes
            const captchaIframes = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="arkoselabs"], iframe[title*="captcha"]')
            let captchaVisible = false
            for (let i = 0; i < await captchaIframes.count(); i++) {
                if (await captchaIframes.nth(i).isVisible()) {
                    captchaVisible = true
                    break
                }
            }

            const text1 = page.locator('text="Verify you are human"')
            const text2 = page.locator('text="Security Check"')
            const isText1 = (await text1.count() > 0) && (await text1.isVisible())
            const isText2 = (await text2.count() > 0) && (await text2.isVisible())

            if (captchaVisible || isText1 || isText2) {
                
                log("WARN", `CAPTCHA/Security check detected during ${contextStr}`)
                if (!headless) {
                     log("INFO", "Waiting for user to solve CAPTCHA manually...")
                     const start = Date.now()
                     while (Date.now() - start < 300000) {
                         // Re-check visibility
                         let stillVisible = false
                         
                         // Check iframes
                         const iframes = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="arkoselabs"], iframe[title*="captcha"]')
                         for (let i = 0; i < await iframes.count(); i++) {
                             if (await iframes.nth(i).isVisible()) {
                                 stillVisible = true
                                 break
                             }
                         }
                         
                         // Check text
                         if (await page.locator('text="Verify you are human"').isVisible()) stillVisible = true
                         if (await page.locator('text="Security Check"').isVisible()) stillVisible = true
                         
                         if (!stillVisible) {
                             log("INFO", "CAPTCHA elements appear to be gone. Resuming.")
                             break
                         }
                         await page.waitForTimeout(2000)
                     }
                 }
            }
        } catch (e) {}
    }

    if (!hasSession) {
      log("INFO", "Logging in")
      await performLogin(page, email, password, navTimeoutMs, headless)
      await checkForCaptcha(page, "post-login")
      
      if (useSession) {
        const state = await context.storageState()
        fs.writeFileSync(sessionPath, JSON.stringify(state))
        log("INFO", "Session persisted", { sessionPath })
      }
    }
    log("INFO", "Navigating to files page")
    await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })

    // Handle EdgePilot wrapper
    if (page.url().includes("edgepilot")) {
        log("INFO", "Detected EdgePilot link, waiting for redirect")
        await checkForCaptcha(page, "EdgePilot redirect")
        try {
            await page.waitForURL(url => !url.toString().includes("edgepilot"), { timeout: 15000 })
            log("INFO", "Redirected from EdgePilot")
        } catch (e) {
            log("WARN", "EdgePilot redirect timeout/error. Attempting manual interaction.", { error: e.message })
            
            // Check for the "Select this button" on EdgePilot
            const manualBtn = page.locator('button:has-text("Select this button if you are not automatically redirected")')
            if (await manualBtn.count() > 0) {
                 log("INFO", "Clicking EdgePilot manual redirect button")
                 await manualBtn.click()
                 try {
                     await page.waitForURL(url => !url.toString().includes("edgepilot"), { timeout: 15000 })
                 } catch (e2) {
                     log("WARN", "Still on EdgePilot after clicking button")
                 }
            } else {
                 const link = page.locator('a[href*="buildingconnected.com"]')
                 if (await link.count() > 0) {
                      log("INFO", "Clicking EdgePilot link")
                      await link.first().click()
                      await page.waitForLoadState("domcontentloaded")
                 } else {
                      log("WARN", "No BuildingConnected link or button found on EdgePilot page")
                      fs.writeFileSync("debug-edgepilot.html", await page.content())
                 }
            }
        }
    }

    // If redirected to login again, we need to handle it
    const currentUrl = page.url()
    if (currentUrl.includes("login") || currentUrl.includes("signin") || currentUrl.includes("auth")) {
       log("INFO", "Redirected to auth page, re-attempting login", { currentUrl })
       await performLogin(page, email, password, navTimeoutMs, headless)
       await checkForCaptcha(page, "re-login")
       
       if (useSession) {
        const state = await context.storageState()
        fs.writeFileSync(sessionPath, JSON.stringify(state))
        log("INFO", "Session refreshed and persisted")
       }

       // Navigate again after re-login
       log("INFO", "Re-navigating to files page")
       await page.goto(opportunityUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
    } else if (currentUrl.includes("join-rfp")) {
        log("INFO", "Landed on Join RFP page, attempting to accept invitation")
        try {
            const acceptBtn = page.locator('button:has-text("Accept Invitation"), button:has-text("View Opportunity"), a:has-text("I’ve used BuildingConnected before")')
            if (await acceptBtn.count() > 0 && await acceptBtn.first().isVisible()) {
                log("INFO", "Clicking Accept/View button on Join RFP page")
                await acceptBtn.first().click()
                await page.waitForLoadState("networkidle", { timeout: 15000 })
                log("INFO", "Navigation after Join RFP click complete", { newUrl: page.url() })
            }
        } catch (e) {
            log("WARN", "Error handling Join RFP page", { error: e.message })
        }
    } else {
        log("INFO", "Landed on page", { currentUrl })
    }

    let filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
    try {
      await filesReady.waitFor({ state: 'visible', timeout: Math.min(waitTimeoutMs, 10000) })
    } catch {
      log("INFO", "Download All button not visible immediately, checking for Files tab or sub-navigation")
      const filesTab = page.locator('a:has-text("Files"), button:has-text("Files"), div[role="tab"]:has-text("Files"), [data-test="files-tab"]')
      const count = await filesTab.count()
      if (count > 0) {
        log("INFO", "Clicking Files tab fallback")
        // Try clicking the first visible one
        for (let i = 0; i < count; i++) {
             if (await filesTab.nth(i).isVisible()) {
                 await filesTab.nth(i).click({ timeout: 10000 })
                 log("INFO", "Clicked a visible Files tab")
                 // Small wait for tab content to load
                 await page.waitForTimeout(2000)
                 break
             }
        }
      }
      filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
      try {
          await filesReady.waitFor({ state: 'visible', timeout: 15000 })
      } catch (e) {
          // Check for sub-navigation or "Documents" which is common in some RFP views
          const docTab = page.locator('a:has-text("Documents"), [data-test="documents-tab"]')
          if (await docTab.count() > 0 && await docTab.first().isVisible()) {
              log("INFO", "Clicking Documents tab fallback")
              await docTab.first().click()
              await page.waitForTimeout(2000)
          }

          filesReady = page.locator('button:has-text("Download All"), button:has-text("Download all")')
          try {
              await filesReady.waitFor({ state: 'visible', timeout: 10000 })
          } catch (e2) {
              // If "Download All" is still not found, check for generic icons
              const dlIcon = page.locator('button i.icon-download, button svg[data-icon="download"], button[aria-label*="Download"]')
              if (await dlIcon.count() > 0 && await dlIcon.first().isVisible()) {
                  log("INFO", "Found generic download icon/button")
                  filesReady = dlIcon.first()
              } else {
                  log("WARN", "Download All button not found. Dumping page content.")
                  fs.writeFileSync("debug-files-page.html", await page.content())
                  
                  // Check if we are back on login page
                  const title = await page.title()
                  if (title.includes("Login") || title.includes("Sign In")) {
                      log("ERROR", "Redirected to Login page unexpectedly")
                  }
                  
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
    const targetPath = path.join(outputDir, suggested)
    await download.saveAs(targetPath)
    const finalPath = await download.path()
    log("INFO", "Download complete", { savedAs: targetPath, tempPath: finalPath })
    await context.close()
    await browser.close()
    return { success: true, downloadedFiles: [targetPath] }
  } catch (err) {
    log("ERROR", "Execution failed", { message: err.message })
    if (useSession && fs.existsSync(sessionPath)) {
      try {
        fs.unlinkSync(sessionPath)
        log("INFO", "Cleared session")
      } catch {}
    }
    if (context) await context.close().catch(() => {})
    await browser.close().catch(() => {})
    return { success: false, error: err.message, stack: err.stack }
  }
}
