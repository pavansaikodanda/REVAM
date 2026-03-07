import fs from 'fs';
import path from 'path';
import { downloadOpportunityFiles, getBackupCode } from './download.js';

/**
 * Orchestrates the full flow on GitHub Actions:
 * 1. Run Playwright automation
 * 2. Upload downloaded files to SharePoint
 * 3. Update Salesforce with the new backup code
 */
async function main() {
    const opportunityUrl = process.env.OPPORTUNITY_URL;
    const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'downloads');
    const salesforceRecordId = process.env.SF_RECORD_ID;

    console.log(`[GH-HANDLER] Starting automation for URL: ${opportunityUrl}`);

    try {
        // 1. Run the automation
        const result = await downloadOpportunityFiles({
            opportunityUrl,
            outputDir,
            headless: true, // Must be true on GitHub Actions
            useSession: false // Start fresh on each trigger
        });

        if (!result.success) {
            console.error('[GH-HANDLER] Automation failed:', result.error);
            process.exit(1);
        }

        console.log('[GH-HANDLER] Automation successful. Files downloaded:', result.downloadedFiles);

        // 2. Post-processing: SharePoint & Salesforce
        const newBackupCode = result.newBackupCode || getBackupCode();
        console.log(`[GH-HANDLER] New backup code captured: ${newBackupCode}`);
        if (process.env.GITHUB_ENV) {
            fs.appendFileSync(process.env.GITHUB_ENV, `newBackupCode=${newBackupCode}\n`);
        }

        // --- SharePoint Upload ---
        for (const filePath of result.downloadedFiles) {
            const fileName = path.basename(filePath);
            await uploadToSharePoint(filePath, fileName);
        }

        // --- Salesforce Update ---
        if (salesforceRecordId) {
            await updateSalesforce(salesforceRecordId, newBackupCode);
        }

        console.log('[GH-HANDLER] Full workflow completed successfully.');

    } catch (err) {
        console.error('[GH-HANDLER] Unexpected error:', err);
        process.exit(1);
    }
}

async function uploadToSharePoint(filePath, fileName) {
    console.log(`[SHAREPOINT-STUB] Uploading ${fileName} to SharePoint...`);
    // Note: To implement actual upload, you'll need the MSAL library and Graph API logic.
    // For now, this is a placeholder where you can add your specific SharePoint logic.
    // Ensure you have SP_CLIENT_ID, SP_CLIENT_SECRET, etc. in GitHub Secrets.
}

async function updateSalesforce(recordId, newCode) {
    console.log(`[SALESFORCE] Updating record ${recordId} with new backup code: ${newCode}`);
    
    const instanceUrl = process.env.SF_INSTANCE_URL;
    const accessToken = process.env.SF_ACCESS_TOKEN;

    if (!instanceUrl || !accessToken) {
        console.warn('[SALESFORCE] SF_INSTANCE_URL or SF_ACCESS_TOKEN missing, skipping update.');
        return;
    }

    // Replace 'Backup_Code__c' with the actual API name of your Salesforce field
    const fieldName = 'Backup_Code__c'; 
    const url = `${instanceUrl}/services/data/v58.0/sobjects/Opportunity/${recordId}`;

    try {
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                [fieldName]: newCode
            })
        });

        if (response.ok) {
            console.log('[SALESFORCE] Successfully updated record with new backup code.');
        } else {
            const errorText = await response.text();
            console.error(`[SALESFORCE] Failed to update record: ${response.status} ${errorText}`);
        }
    } catch (err) {
        console.error('[SALESFORCE] Error during Salesforce update:', err);
    }
}

main();
