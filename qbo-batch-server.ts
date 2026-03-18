// qbo-batch-server.ts
// Single file — Express server + Stagehand task
// Deploy on Render, call from n8n Schedule Trigger via POST /run-qbo-batch

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// HELPERS
// =============================================================================

async function waitUntilVisible(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (visible) return true;
    } catch { /* not ready */ }
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

// =============================================================================
// MAIN TASK
// =============================================================================

async function runQBOBatchTask() {
  const email    = process.env.SERA_EMAIL    || "mcc@stratablue.com";
  const password = process.env.SERA_PASSWORD || "";
  const startTime = Date.now();
  const context: any = {};

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

    // ------------------------------------------------------------------
    // STEP 1 — Login
    // ------------------------------------------------------------------
    console.log("\n[1] → Navigating to login page");
    await page.goto("https://misterquik.sera.tech/admins/login", {
      waitUntil: "domcontentloaded",
      timeoutMs: 60000,
    });
    await page.waitForTimeout(2000);

    const currentUrl: string = await page.url();
    if (currentUrl.includes("/login")) {
      console.log("    → Filling credentials");
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

      // Click Sign In button
      const clicked = await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll('button, input[type="submit"]')
        ).find(
          (el) =>
            ["sign in", "login", "log in"].some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) {
        await page.locator('button[type="submit"]').first().click();
      }

      // Wait for redirect away from login
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const url: string = await page.url();
        if (!url.includes("/login")) {
          console.log(`    ✅ Logged in — redirected to: ${url}`);
          break;
        }
        if (i === 29) throw new Error("Still on login page after 30s — check credentials");
      }
    } else {
      console.log("    ✅ Already logged in");
    }

    // ------------------------------------------------------------------
    // STEP 2 — Navigate to Financials → Unbatched
    // ------------------------------------------------------------------
    console.log("\n[2] → Clicking Financials in sidebar");
    await page.waitForTimeout(2000);
    const financialsClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a, button, li, span")).find(
        (e) =>
          e.textContent?.trim().toLowerCase() === "financials" &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    });
    if (!financialsClicked) throw new Error('"Financials" not found in sidebar');
    await page.waitForTimeout(1500);

    console.log("\n[3] → Clicking Unbatched");
    const unbatchedClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a, button, li, span")).find(
        (e) =>
          e.textContent?.trim().toLowerCase() === "unbatched" &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    });
    if (!unbatchedClicked) throw new Error('"Unbatched" not found');
    await page.waitForTimeout(3000);

    // ------------------------------------------------------------------
    // STEP 3 — Clear any selected Payments
    // ------------------------------------------------------------------
    console.log("\n[4] → Clicking Payments tab");
    const paymentsTabClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a, button, [role='tab'], li")).find(
        (e) =>
          e.textContent?.trim().toLowerCase() === "payments" &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    });
    if (!paymentsTabClicked) console.log("    ⚠️  Payments tab not found — skipping");
    await page.waitForTimeout(2000);

    console.log("\n[5] → Checking for selected payments");
    const anySelected = await page.evaluate(() => {
      const selectAll = document.querySelector(
        'input[type="checkbox"][data-cy*="select-all"], th input[type="checkbox"]'
      ) as HTMLInputElement | null;
      if (selectAll?.checked) return true;
      const rowCbs = Array.from(
        document.querySelectorAll('tbody input[type="checkbox"]')
      ) as HTMLInputElement[];
      return rowCbs.some((cb) => cb.checked);
    });

    if (anySelected) {
      console.log("    → Payments selected — deselecting all");
      await page.evaluate(() => {
        const cb = document.querySelector(
          'input[type="checkbox"][data-cy*="select-all"], th input[type="checkbox"]'
        ) as HTMLInputElement | null;
        if (cb) cb.click();
      });
      await page.waitForTimeout(1000);
    } else {
      console.log("    ✅ No payments selected");
    }
    context.paymentsCleared = true;

    // ------------------------------------------------------------------
    // STEP 4 — Process Invoices
    // ------------------------------------------------------------------
    console.log("\n[6] → Clicking Invoices tab");
    const invoicesTabClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a, button, [role='tab'], li")).find(
        (e) =>
          e.textContent?.trim().toLowerCase() === "invoices" &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    });
    if (!invoicesTabClicked) throw new Error('"Invoices" tab not found');
    await page.waitForTimeout(2000);

    console.log("\n[7] → Counting invoices");
    const invoiceCount: number = await page.evaluate(() => {
      return document.querySelectorAll("tbody tr").length;
    });
    console.log(`    ℹ️  ${invoiceCount} invoice(s) found`);
    context.invoiceCount = invoiceCount;

    if (invoiceCount === 0) {
      context.noInvoices = true;
      context.completionMessage = "Task completed: No invoices found to batch.";
      console.log("    ✅ Nothing to batch — done");
    } else {
      console.log("\n[8] → Selecting all invoices");
      const selectAllClicked = await page.evaluate(() => {
        const byCy = document.querySelector(
          'input[data-cy*="select-all"], th input[type="checkbox"], thead input[type="checkbox"]'
        ) as HTMLInputElement | null;
        if (byCy) { byCy.click(); return true; }
        return false;
      });
      if (!selectAllClicked) throw new Error("Select All checkbox not found");
      await page.waitForTimeout(1500);

      console.log("\n[9] → Clicking Send to QuickBooks");
      const qbClicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("button, a")).find(
          (e) =>
            (e.textContent?.toLowerCase().includes("send to quickbooks") ||
              e.textContent?.toLowerCase().includes("quickbooks")) &&
            (e as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (el) { el.click(); return true; }
        return false;
      });
      if (!qbClicked) throw new Error('"Send to QuickBooks" button not found');
      await page.waitForTimeout(2000);

      console.log("\n[10] → Verifying modal — checking no Payments included");
      await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content', 10000);
      await page.waitForTimeout(1000);

      const paymentsInModal: number = await page.evaluate(() => {
        const modal = document.querySelector('.modal, [role="dialog"], .modal-content');
        if (!modal) return 0;
        const text = modal.textContent || "";
        const m = text.match(/payments?[:\s]+(\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
      });

      if (paymentsInModal > 0) {
        throw new Error(
          `Modal shows ${paymentsInModal} payment(s) — aborting. Deselect payments and retry.`
        );
      }
      console.log("    ✅ Modal verified — zero payments");

      console.log("\n[11] → Clicking Create Batch");
      const createBatchClicked = await page.evaluate(() => {
        const modal = document.querySelector('.modal, [role="dialog"], .modal-content');
        const scope = modal || document;
        const el = Array.from(scope.querySelectorAll("button")).find(
          (e) =>
            e.textContent?.toLowerCase().includes("create batch") &&
            (e as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (el) { el.click(); return true; }
        // Fallback: primary/submit button inside modal
        const fallback = scope.querySelector(
          'button[type="submit"], button.btn-primary'
        ) as HTMLElement | null;
        if (fallback) { fallback.click(); return true; }
        return false;
      });
      if (!createBatchClicked) throw new Error('"Create Batch" button not found');
      await page.waitForTimeout(3000);

      console.log("\n[12] → Waiting for batch confirmation");
      await waitUntilHidden(page, '.modal, [role="dialog"], .modal-content', 30000);
      context.batchCreated = true;
      context.completionMessage = `Batch created successfully. ${invoiceCount} invoice(s) sent to QuickBooks.`;
      console.log(`    ✅ ${context.completionMessage}`);
    }
  } catch (error: any) {
    console.error(`\n❌ Task error: ${error.message}`);
    context.taskError = error.message;
    context.completionMessage = `Task failed: ${error.message}. Check session replay.`;
  } finally {
    await stagehand.close();
    console.log("\n🔒 Browser session closed");
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const success = !!context.batchCreated || !!context.noInvoices;

  return {
    success,
    message:         context.completionMessage || "Task did not complete — check session replay.",
    invoiceCount:    context.invoiceCount    ?? 0,
    noInvoices:      context.noInvoices      ?? false,
    paymentsCleared: context.paymentsCleared ?? false,
    batchCreated:    context.batchCreated    ?? false,
    elapsedMinutes:  parseFloat(elapsed),
    sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "qbo-batch-server" });
});

app.post("/run-qbo-batch", async (_req, res) => {
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-qbo-batch received`);
  try {
    const result = await runQBOBatchTask();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 QBO Batch Server running on port ${PORT}`);
  console.log(`   POST /run-qbo-batch  ← n8n Schedule Trigger calls this`);
  console.log(`   GET  /health         ← Render health check\n`);
});
