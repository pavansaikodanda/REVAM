# Salesforce & SharePoint Integration Guide

This guide explains how to trigger your automation script from Salesforce and handle the results.

## Overview

We have added a lightweight Integration Server (`src/server.js`) that acts as a bridge:

1.  **Salesforce** sends a request to this server.
2.  **Server** updates the local `.backup_code` file.
3.  **Server** runs your existing automation script (`src/index.js`).
4.  **Server** captures the *new* backup code and downloaded files.
5.  **Server** (Optional) uploads files to SharePoint and sends the new code back to Salesforce.

## Setup

### 1. Install Dependencies
We need a few extra packages to run the web server.
```bash
npm install express body-parser
```

### 2. Configure Environment Variables
You can set these in your `.env` file or in your system environment.

**Required for Basic Automation:**
*   `BC_EMAIL`: Your BuildingConnected Email
*   `BC_PASSWORD`: Your BuildingConnected Password
*   `OUTPUT_DIR`: Where files should be saved (e.g., `d:/tmp/bc-downloads`)

**Required for Salesforce Integration (if enabling write-back):**
*   `SF_INSTANCE_URL`: Your Salesforce Domain (e.g., `https://your-org.my.salesforce.com`)
*   `SF_ACCESS_TOKEN`: An OAuth token or Session ID to allow the script to update records.

**Required for SharePoint Integration:**
*   `SP_TENANT_ID`: Azure AD Tenant ID
*   `SP_CLIENT_ID`: App Client ID
*   `SP_CLIENT_SECRET`: App Secret
*   `SP_DRIVE_ID`: Target Document Library ID

## Running the Server

Run the server using Node:

```bash
node src/server.js
```

The server will start on port **3000**.

## How to Trigger from Salesforce

You need to send a **HTTP POST** request to your server.

**Endpoint:** `POST http://<YOUR-SERVER-IP>:3000/trigger`

**JSON Body:**
```json
{
  "backupCode": "R2YG-6LEF",
  "opportunityUrl": "https://link.edgepilot.com/...",
  "salesforceRecordId": "006xxxxxxxxxxxx"
}
```

### Exposing to the Internet (Free)
If you are running this on your local laptop, Salesforce cannot reach `localhost`. You can use **ngrok** to create a secure tunnel.

1.  Download and install [ngrok](https://ngrok.com/).
2.  Run: `ngrok http 3000`
3.  Copy the `https://....ngrok-free.app` URL.
4.  Use this URL in your Salesforce Apex Trigger / Flow.

## Example Salesforce Apex Code

Here is a snippet you can use in Salesforce:

```java
public class BuildingConnectedService {
    @future(callout=true)
    public static void triggerAutomation(String backupCode, String oppUrl, String recordId) {
        Http http = new Http();
        HttpRequest req = new HttpRequest();
        req.setEndpoint('https://your-ngrok-url.app/trigger');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        
        String body = JSON.serialize(new Map<String, String>{
            'backupCode' => backupCode,
            'opportunityUrl' => oppUrl,
            'salesforceRecordId' => recordId
        });
        
        req.setBody(body);
        HttpResponse res = http.send(req);
    }
}
```
