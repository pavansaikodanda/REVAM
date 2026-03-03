const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { promisify } = require('util');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BACKUP_CODE_FILE = path.join(process.cwd(), '.backup_code');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'bc-downloads');

// --- CONFIGURATION ---
// You must set these environment variables for the integration to work
const SHAREPOINT_CONFIG = {
    tenantId: process.env.SP_TENANT_ID,
    clientId: process.env.SP_CLIENT_ID,
    clientSecret: process.env.SP_CLIENT_SECRET,
    driveId: process.env.SP_DRIVE_ID // The ID of the document library/folder
};

const SALESFORCE_CONFIG = {
    instanceUrl: process.env.SF_INSTANCE_URL, // e.g., https://your-domain.my.salesforce.com
    accessToken: process.env.SF_ACCESS_TOKEN  // Or implement full OAuth flow
};

// --- ROUTES ---

// Health check
app.get('/', (req, res) => {
    res.send('BuildingConnected Automation Server is Running');
});

/**
 * Trigger Endpoint
 * Expected JSON Body:
 * {
 *   "backupCode": "ABCD-1234",
 *   "opportunityUrl": "https://...",
 *   "salesforceRecordId": "006..." // ID of the record to update later
 * }
 */
app.post('/trigger', async (req, res) => {
    const { backupCode, opportunityUrl, salesforceRecordId } = req.body;

    if (!backupCode || !opportunityUrl) {
        return res.status(400).json({ error: 'Missing backupCode or opportunityUrl' });
    }

    console.log(`[JOB START] Received trigger for ${salesforceRecordId || 'unknown record'}`);

    // 1. Update the local .backup_code file with the one from Salesforce
    try {
        fs.writeFileSync(BACKUP_CODE_FILE, backupCode.trim());
        console.log(`[SETUP] Updated .backup_code with: ${backupCode}`);
    } catch (err) {
        console.error('[ERROR] Failed to write backup code:', err);
        return res.status(500).json({ error: 'Internal Server Error: Could not save backup code' });
    }

    // 2. Start the automation process asynchronously
    // We return a response immediately so Salesforce doesn't timeout
    res.json({ status: 'started', message: 'Automation job has been queued.' });

    // Run the job in background
    runAutomationJob(opportunityUrl, salesforceRecordId);
});

// --- CORE LOGIC ---

async function runAutomationJob(opportunityUrl, salesforceRecordId) {
    console.log('[PROCESS] Starting Playwright script...');

    // Prepare environment variables for the child process
    const env = { 
        ...process.env, 
        OPPORTUNITY_URL: opportunityUrl,
        // Ensure we force headless=true for server environments (optional, remove if running locally with UI)
        // HEADLESS: 'true' 
    };

    const child = spawn('node', ['src/index.js'], { env, shell: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
        const msg = data.toString();
        stdout += msg;
        console.log(`[SCRIPT] ${msg.trim()}`);
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString();
        stderr += msg;
        console.error(`[SCRIPT ERR] ${msg.trim()}`);
    });

    child.on('close', async (code) => {
        console.log(`[PROCESS] Script finished with exit code ${code}`);

        if (code === 0) {
            await handleJobSuccess(salesforceRecordId);
        } else {
            console.error('[PROCESS] Job failed.');
            // Optional: Call Salesforce to report failure
        }
    });
}

async function handleJobSuccess(salesforceRecordId) {
    try {
        // 1. Read the NEW backup code
        let newBackupCode = null;
        if (fs.existsSync(BACKUP_CODE_FILE)) {
            newBackupCode = fs.readFileSync(BACKUP_CODE_FILE, 'utf8').trim();
            console.log(`[RESULT] New Backup Code Generated: ${newBackupCode}`);
        } else {
            console.warn('[WARN] .backup_code file not found after run');
        }

        // 2. Identify downloaded files
        const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.zip') || f.endsWith('.pdf')); // Adjust extensions
        console.log(`[RESULT] Found ${files.length} files to upload: ${files.join(', ')}`);

        // 3. Upload to SharePoint
        for (const file of files) {
            const filePath = path.join(OUTPUT_DIR, file);
            await uploadToSharePoint(filePath, file);
        }

        // 4. Send Info Back to Salesforce
        if (salesforceRecordId && newBackupCode) {
            await updateSalesforceRecord(salesforceRecordId, newBackupCode, files);
        } else {
            console.log('[INFO] Skipping Salesforce update (no record ID or code)');
        }

        console.log('[JOB COMPLETE] All post-processing steps finished.');

    } catch (err) {
        console.error('[ERROR] Post-processing failed:', err);
    }
}

// --- INTEGRATION STUBS ---

async function uploadToSharePoint(filePath, fileName) {
    console.log(`[MOCK UPLOAD] Would upload ${fileName} to SharePoint...`);
    // Implementation requires Microsoft Graph API
    // 1. Get Access Token (using client_credentials flow)
    // 2. PUT /drives/{drive-id}/items/root:/{fileName}:/content
    
    // Example (Pseudo-code):
    /*
    const token = await getMicrosoftGraphToken();
    const fileStream = fs.createReadStream(filePath);
    await fetch(`https://graph.microsoft.com/v1.0/drives/${SHAREPOINT_CONFIG.driveId}/items/root:/${fileName}:/content`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: fileStream
    });
    */
}

async function updateSalesforceRecord(recordId, newCode, fileList) {
    console.log(`[MOCK SF UPDATE] Updating Record ${recordId} with new code: ${newCode}`);
    
    if (!SALESFORCE_CONFIG.instanceUrl || !SALESFORCE_CONFIG.accessToken) {
        console.warn('[WARN] Salesforce credentials missing, skipping update.');
        return;
    }

    // Example: Update a custom field 'Backup_Code__c'
    const url = `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Opportunity/${recordId}`;
    
    try {
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${SALESFORCE_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                Backup_Code__c: newCode,
                // Description: `Downloaded files: ${fileList.join(', ')}` 
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Salesforce API Error: ${errText}`);
        }
        console.log('[SUCCESS] Salesforce record updated successfully.');
    } catch (err) {
        console.error('[ERROR] Failed to update Salesforce:', err);
    }
}


// Start Server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Endpoint: POST http://localhost:${PORT}/trigger`);
});
