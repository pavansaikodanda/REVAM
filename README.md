# BuildingConnected Files Automation (Playwright)

- Logs into BuildingConnected with email/password
- Navigates to an Opportunity Files page
- Clicks Download All and saves the ZIP
- Supports session reuse via storage state
- Works headless by default, headful for debugging

## Prerequisites

- Node.js 18+
- Install dependencies:

```bash
npm install
```

## Environment

- Copy `.env.example` to `.env` and set credentials:

```bash
BC_EMAIL=your-email@example.com
BC_PASSWORD=your-password
OPPORTUNITY_URL=https://app.buildingconnected.com/opportunities/12345/files
OUTPUT_DIR=d:/tmp/bc-downloads
HEADLESS=true
USE_SESSION=true
```

## Usage

- Programmatic:

```js
import { downloadOpportunityFiles } from "./src/index.js";

const res = await downloadOpportunityFiles({
  opportunityUrl: "https://app.buildingconnected.com/opportunities/12345/files",
  outputDir: "d:/tmp/bc-downloads",
  headless: true,
  useSession: true,
});
console.log(res);
```

- CLI-like via script:

```bash
npm run run
```

Outputs:

```json
{
  "success": true,
  "downloadedFiles": [
    "d:/tmp/bc-downloads/planset.zip"
  ]
}
```

## Implementation Notes

- Browser: Playwright Chromium
- Context: `acceptDownloads: true`
- Download capture: `page.waitForEvent("download")` then `download.saveAs()`
- Login page: `https://app.buildingconnected.com/login`
- Selectors: `input[name="email"]`, `input[name="password"]`, `button[type="submit"]`, `button:has-text("Download All")`
- Session file: `.bc-session.json` in project root

## Error Handling and Logging

- Logs start, login, navigation, download progress, final paths
- Returns `{ success: false, error, stack }` on failure
- Clears stale session file when errors occur

## Headful Debugging

- Set `HEADLESS=false` or pass `headless: false` to the function

## Notes

- UI selectors may change; adjust if needed
- Ensure the opportunity URL points to `/opportunities/{opportunityId}/files`
