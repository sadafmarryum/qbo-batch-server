// qbo-batch-server.ts
// Express server + Stagehand task with background jobs and polling
// Deploy on Render, call from n8n Schedule Trigger
//
// n8n HTTP Request node — POST /run-qbo-batch
// Poll with GET /job-status/:jobId

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";
import { v4 as uuidv4 } from "uuid";

// ==============================================
// JOB TRACKING (in-memory)
// ==============================================
interface JobStatus {
  id: string;
  startedAt: number;
  finishedAt?: number;
  success?: boolean;
  message?: string;
  batchNumber?: string;
}

const jobs: Record<string, JobStatus> = {};

// ==============================================
// HELPERS
// ==============================================

async function waitUntilVisible(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (visible) return true;
    } catch { }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout (${timeoutMs}ms): "${selector}" never became visible`);
}

async function waitUntilHidden(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (!visible) return true;
    } catch { return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

async function sleepWithCountdown(page: any, totalMs: number, intervalMs = 30000): Promise<void> {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    console.log(`    ⏳ ${remaining}s remaining...`);
    await page.waitForTimeout(Math.min(intervalMs, end - Date.now()));
  }
}

async function deselectAllOnCurrentTab(page: any): Promise<number> {
  return await page.evaluate(() => {
    const headerCb = document.querySelector(
      'thead input[type="checkbox"], th input[type="checkbox"]'
    ) as HTMLInputElement | null;
    if (headerCb && headerCb.checked) {
      headerCb.click();
      return 1;
    }
    const rowCbs = Array.from(
      document.querySelectorAll('tbody input[type="checkbox"]:checked')
    ) as HTMLInputElement[];
    rowCbs.forEach(cb => cb.click());
    return rowCbs.length;
  });
}

async function clickTab(page: any, tabName: "Invoices" | "Payments"): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await page.evaluate((pattern: string) => {
      const re = new RegExp(pattern, "i");
      const el = Array.from(
        document.querySelectorAll("a, button, [role='tab'], li, span")
      ).find(
        (e) => re.test(e.textContent?.trim() || "") &&
               (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    }, `^${tabName}`);
    if (clicked) return true;
    console.log(`    ⚠️  "${tabName}" tab not found — attempt ${attempt + 1}/5`);
    await page.waitForTimeout(2000);
  }
  return false;
}

// ==============================================
// MAIN TASK
// ==============================================

async function runQBOBatchTask(options: { testInvoiceUrl?: string } = {}) {
  const email     = process.env.SERA_EMAIL    || "mcc@stratablue.com";
  const password  = process.env.SERA_PASSWORD || "";

  const startTime = Date.now();
  const context: any = {};

  const isTestMode   = !!options.testInvoiceUrl;
  const unbatchedUrl = options.testInvoiceUrl || "https://misterquik.sera.tech/accounting/unbatched";

  console.log(isTestMode
    ? `\n🧪 TEST MODE — URL: ${unbatchedUrl}`
    : "\n🚀 PRODUCTION MODE — processing all unbatched invoices"
  );

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY || "",
    },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session started: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // -------------------------
    // STEP 1 — Login
    // -------------------------
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    const currentUrl: string = await page.url();
    if (currentUrl.includes("/login")) {
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

      const clicked = await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll('button, input[type="submit"]')
        ).find(el =>
          ["sign in", "login", "log in"].some(
            kw => el.textContent?.toLowerCase().trim() === kw ||
                  (el as HTMLInputElement).value?.toLowerCase() === kw
          ) && (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) await page.locator('button[type="submit"]').first().click();

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!(await page.url()).includes("/login")) break;
      }
    }

    // -------------------------
    // STEP 2 — Navigate to unbatched
    // -------------------------
    await page.goto(unbatchedUrl);

    if (isTestMode) {
      await page.waitForTimeout(15000);
    } else {
      // replace fixed 5min wait with DOM detection if possible
      await sleepWithCountdown(page, 5 * 60 * 1000);
    }

    // -------------------------
    // STEP 3 — Tab counts
    // -------------------------
    const tabCounts = await page.evaluate(() => {
      let invoiceCount = 0;
      let paymentCount = 0;

      const allEls = Array.from(document.querySelectorAll("a, button, [role='tab'], li, span, div"))
        .filter(e => (e as HTMLElement).offsetParent !== null);

      let invoiceTabLabel = "";
      let paymentTabLabel = "";

      for (const el of allEls) {
        const text = el.textContent?.trim() || "";

        const invMatch = text.match(/^invoices?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
        if (invMatch && !invoiceTabLabel) {
          invoiceCount = parseInt(invMatch[1], 10);
          invoiceTabLabel = text;
        }

        const payMatch = text.match(/^payments?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
        if (payMatch && !paymentTabLabel) {
          paymentCount = parseInt(payMatch[1], 10);
          paymentTabLabel = text;
        }
      }

      return { invoiceCount, paymentCount, invoiceTabLabel, paymentTabLabel };
    });

    context.invoiceCount = tabCounts.invoiceCount;

    if (tabCounts.invoiceCount === 0) {
      context.noInvoices = true;
      context.completionMessage = "No invoices found to batch.";
      console.log("✅ No invoices to batch");
    } else {
      // -------------------------
      // STEP 4 → 11 — existing logic
      // (select invoices, deselect payments, click Send to QB, read modal, create batch)
      // Reuse your previous code here...
      // -------------------------
      console.log("⚡ Running batch steps...");
      // For brevity, copy all your steps 4–11 from your original file
    }

  } catch (error: any) {
    console.error(`❌ Task error: ${error.message}`);
    context.taskError = error.message;
    context.completionMessage = `Task failed: ${error.message}. Session: ${sessionUrl}`;
  } finally {
    await stagehand.close();
    console.log("🔒 Browser session closed");
  }

  const success = !!context.batchCreated || !!context.noInvoices;

  return {
    success,
    message: context.completionMessage || "Task did not complete — check session replay.",
    testMode: isTestMode,
    invoiceCount: context.invoiceCount ?? 0,
    invoiceAmount: context.invoiceAmount ?? "N/A",
    invoiceItems: context.invoiceItems ?? "0",
    paymentAmount: context.paymentAmount ?? "$0.00",
    paymentItems: context.paymentItems ?? "0",
    batchNumber: context.batchNumber ?? "",
    noInvoices: context.noInvoices ?? false,
    paymentsCleared: context.paymentsCleared ?? false,
    batchCreated: context.batchCreated ?? false,
    sessionUrl,
  };
}

// ==============================================
// EXPRESS SERVER
// ==============================================

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "qbo-batch-server" });
});

// Start a job
app.post("/run-qbo-batch", (req, res) => {
  const testInvoiceUrl = req.body?.testInvoiceUrl;
  const jobId = uuidv4();
  jobs[jobId] = { id: jobId, startedAt: Date.now() };

  // Respond immediately to n8n
  res.json({
    success: true,
    message: "QBO batch job started",
    jobId,
  });

  // Run task in background
  runQBOBatchTask({ testInvoiceUrl })
    .then(result => {
      jobs[jobId] = {
        ...jobs[jobId],
        finishedAt: Date.now(),
        success: result.success,
        message: result.message,
        batchNumber: result.batchNumber,
      };
      console.log(`✅ Job ${jobId} finished`, result);
    })
    .catch(err => {
      jobs[jobId] = {
        ...jobs[jobId],
        finishedAt: Date.now(),
        success: false,
        message: err.message,
      };
      console.error(`❌ Job ${jobId} failed`, err.message);
    });
});

// Job status polling
app.get("/job-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];

  if (!job) return res.status(404).json({ success: false, message: "Job not found" });

  const status = job.finishedAt
    ? (job.success ? "complete" : "failed")
    : "pending";

  res.json({
    jobId: job.id,
    status,
    success: job.success ?? null,
    message: job.message ?? null,
    batchNumber: job.batchNumber ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 QBO Batch Server running on port ${PORT}`);
});
