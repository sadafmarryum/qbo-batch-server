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
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    const currentUrl: string = await page.url();
    if (currentUrl.includes("/login")) {
      console.log("    → Filling credentials");
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

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
    // STEP 2 — Navigate directly to Unbatched page
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to Unbatched page");
    await page.goto("https://misterquik.sera.tech/accounting/unbatched");
    await page.waitForTimeout(5000);

    const pageTitle: string = await page.evaluate(() => {
      return document.title || document.querySelector("h1, h2")?.textContent || "";
    });
    console.log(`    ℹ️  Page: ${pageTitle}`);

    // ------------------------------------------------------------------
    // STEP 3 — Clear any active filters
    // ------------------------------------------------------------------
    console.log("\n[3] → Clearing any active filters");
    await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="date"], input[type="text"]')
      ) as HTMLInputElement[];
      inputs.forEach(inp => {
        if (inp.value && inp.placeholder?.toLowerCase().includes("search")) {
          inp.value = "";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });
    await page.waitForTimeout(1000);

    // ------------------------------------------------------------------
    // STEP 4 — Click Payments tab and deselect all
    // ------------------------------------------------------------------
    console.log("\n[4] → Clicking Payments tab");
    const paymentsTabClicked = await page.evaluate(() => {
      const el = Array.from(
        document.querySelectorAll("a, button, [role='tab'], li, span")
      ).find(
        (e) =>
          e.textContent?.trim() === "Payments" &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    });
    if (!paymentsTabClicked) console.log("    ⚠️  Payments tab not found — skipping");
    await page.waitForTimeout(2000);

    console.log("\n[5] → Checking for selected payments");
    const anyPaymentsSelected = await page.evaluate(() => {
      const cbs = Array.from(
        document.querySelectorAll('tbody input[type="checkbox"]')
      ) as HTMLInputElement[];
      return cbs.some((cb) => cb.checked);
    });

    if (anyPaymentsSelected) {
      console.log("    → Deselecting all payments");
      await page.evaluate(() => {
        const cb = document.querySelector(
          'thead input[type="checkbox"], th input[type="checkbox"]'
        ) as HTMLInputElement | null;
        if (cb) cb.click();
      });
      await page.waitForTimeout(1000);
    } else {
      console.log("    ✅ No payments selected");
    }
    context.paymentsCleared = true;

    // ------------------------------------------------------------------
    // STEP 5 — Click Invoices tab
    // ------------------------------------------------------------------
    console.log("\n[6] → Clicking Invoices tab");
    let invoicesTabClicked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      invoicesTabClicked = await page.evaluate(() => {
        const el = Array.from(
          document.querySelectorAll("a, button, [role='tab'], li, span")
        ).find(
          (e) =>
            e.textContent?.trim() === "Invoices" &&
            (e as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (el) { el.click(); return true; }
        return false;
      });
      if (invoicesTabClicked) break;
      console.log(`    ⚠️  Invoices tab not found — attempt ${attempt + 1}/5`);
      await page.waitForTimeout(2000);
    }

    if (!invoicesTabClicked) {
      const visibleItems: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a, button, [role='tab']"))
          .filter(e => (e as HTMLElement).offsetParent !== null)
          .map(e => e.textContent?.trim() || "")
          .filter(t => t.length > 0 && t.length < 40)
          .slice(0, 20)
      );
      throw new Error(`Invoices tab not found. Visible items: ${visibleItems.join(", ")}`);
    }
    await page.waitForTimeout(3000);

    // ------------------------------------------------------------------
    // STEP 6 — Count invoices and read header totals
    // ------------------------------------------------------------------
    console.log("\n[7] → Counting invoices");
    await page.waitForTimeout(2000);

    const invoiceCount: number = await page.evaluate(() => {
      const rows = document.querySelectorAll("tbody tr");
      const dataRows = Array.from(rows).filter(row => {
        const text = row.textContent?.trim() || "";
        return text.length > 0 &&
          !text.toLowerCase().includes("no matching") &&
          !text.toLowerCase().includes("no records") &&
          !text.toLowerCase().includes("no results");
      });
      return dataRows.length;
    });

    console.log(`    ℹ️  ${invoiceCount} invoice(s) found`);
    context.invoiceCount = invoiceCount;

    if (invoiceCount === 0) {
      context.noInvoices = true;
      context.completionMessage = "No invoices found to batch today.";
      console.log("    ✅ Nothing to batch — done");

    } else {
      // ------------------------------------------------------------------
      // STEP 7 — Select all invoices
      // ------------------------------------------------------------------
      console.log("\n[8] → Selecting all invoices");
      const selectAllClicked = await page.evaluate(() => {
        const cb = document.querySelector(
          "thead input[type='checkbox'], th input[type='checkbox']"
        ) as HTMLInputElement | null;
        if (cb) { cb.click(); return true; }
        return false;
      });
      if (!selectAllClicked) throw new Error("Select All checkbox not found");
      await page.waitForTimeout(1500);

      // Read the header totals shown after selection e.g. "Total Invoices: $44,701.84"
      const headerTotals: { invoiceTotal: string; paymentTotal: string } = await page.evaluate(() => {
        const text = document.body.textContent || "";
        const invMatch = text.match(/total invoices?[:\s]+\$?([\d,\.]+)/i);
        const payMatch = text.match(/total payments?[:\s]+\$?([\d,\.]+)/i);
        return {
          invoiceTotal: invMatch ? `$${invMatch[1]}` : "unknown",
          paymentTotal: payMatch ? `$${payMatch[1]}` : "$0.00",
        };
      });
      console.log(`    ℹ️  Invoice total: ${headerTotals.invoiceTotal}`);
      console.log(`    ℹ️  Payment total: ${headerTotals.paymentTotal}`);
      context.invoiceTotal = headerTotals.invoiceTotal;
      context.paymentTotal = headerTotals.paymentTotal;

      // ------------------------------------------------------------------
      // STEP 8 — Click Send to QuickBooks
      // ------------------------------------------------------------------
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
      await page.waitForTimeout(3000);

      // ------------------------------------------------------------------
      // STEP 9 — Read modal details (batch number, totals, payment count)
      // ------------------------------------------------------------------
      console.log("\n[10] → Reading batch modal details");
      await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content, .sera-modal', 15000);
      await page.waitForTimeout(1500);

      const modalDetails: {
        batchNumber: string;
        invoiceAmount: string;
        invoiceItems: string;
        paymentAmount: string;
        paymentItems: string;
        paymentsCount: number;
      } = await page.evaluate(() => {
        const modal = document.querySelector(
          '.modal, [role="dialog"], .modal-content, .sera-modal'
        );
        const text = modal?.textContent || document.body.textContent || "";

        // Extract batch number e.g. "Batch #46495"
        const batchMatch = text.match(/batch\s*#?(\d+)/i);

        // Extract invoice total e.g. "$44,701.84 (26 items)"
        const invAmtMatch = text.match(/invoices?[^\$]*\$?([\d,\.]+)\s*\((\d+)\s*items?\)/i);

        // Extract payment total e.g. "$0.00 (0 items)"
        const payAmtMatch = text.match(/payments?[^\$]*\$?([\d,\.]+)\s*\((\d+)\s*items?\)/i);

        // Simple payment count check
        const payCountMatch = text.match(/payments?[:\s]+(\d+)/i);

        return {
          batchNumber:   batchMatch   ? batchMatch[1]   : "",
          invoiceAmount: invAmtMatch  ? `$${invAmtMatch[1]}` : "unknown",
          invoiceItems:  invAmtMatch  ? invAmtMatch[2]  : "unknown",
          paymentAmount: payAmtMatch  ? `$${payAmtMatch[1]}` : "$0.00",
          paymentItems:  payAmtMatch  ? payAmtMatch[2]  : "0",
          paymentsCount: payCountMatch ? parseInt(payCountMatch[1], 10) : 0,
        };
      });

      console.log(`    ℹ️  Batch number: ${modalDetails.batchNumber || "not found"}`);
      console.log(`    ℹ️  Invoice total: ${modalDetails.invoiceAmount} (${modalDetails.invoiceItems} items)`);
      console.log(`    ℹ️  Payment total: ${modalDetails.paymentAmount} (${modalDetails.paymentItems} items)`);

      if (modalDetails.paymentsCount > 0) {
        throw new Error(
          `Modal shows ${modalDetails.paymentsCount} payment(s) — aborting to avoid including payments.`
        );
      }
      console.log("    ✅ Verified — zero payments in batch");

      context.batchNumber   = modalDetails.batchNumber   || "";
      context.invoiceAmount = modalDetails.invoiceAmount;
      context.invoiceItems  = modalDetails.invoiceItems;
      context.paymentAmount = modalDetails.paymentAmount;
      context.paymentItems  = modalDetails.paymentItems;

      // ------------------------------------------------------------------
      // STEP 10 — Click Create Batch
      // ------------------------------------------------------------------
      console.log("\n[11] → Clicking Create Batch");
      const createBatchClicked = await page.evaluate(() => {
        const modal = document.querySelector(
          '.modal, [role="dialog"], .modal-content, .sera-modal'
        );
        const scope = modal || document;
        const byText = Array.from(scope.querySelectorAll("button")).find(
          (e) =>
            e.textContent?.toLowerCase().includes("create batch") &&
            (e as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (byText) { byText.click(); return "create batch"; }
        const fallback = scope.querySelector(
          'button[type="submit"], button.btn-primary, button.primary'
        ) as HTMLElement | null;
        if (fallback) { fallback.click(); return "fallback"; }
        return null;
      });
      if (!createBatchClicked) throw new Error('"Create Batch" button not found');
      await page.waitForTimeout(5000);

      // ------------------------------------------------------------------
      // STEP 11 — Wait for modal to close (batch processing)
      // ------------------------------------------------------------------
      console.log("\n[12] → Waiting for batch to complete");
      await waitUntilHidden(page, '.modal, [role="dialog"], .modal-content', 30000);

      context.batchCreated = true;

      // Build detailed completion message matching your required format
      const batchLabel = context.batchNumber ? `Batch #${context.batchNumber}` : "Batch";
      context.completionMessage = [
        `**Invoice Processing:** Selected all ${invoiceCount} invoices on the 'Invoices' tab.`,
        `**Batch Creation:** Created ${batchLabel}.`,
        `   - **Total Invoices:** ${context.invoiceAmount} (${context.invoiceItems} items)`,
        `   - **Total Payments:** ${context.paymentAmount} (${context.paymentItems} items)`,
        `**Confirmation:** The batch is currently processing on the system.`,
      ].join("\n");

      console.log(`\n✅ ${context.completionMessage}`);
    }

  } catch (error: any) {
    console.error(`\n❌ Task error: ${error.message}`);
    context.taskError = error.message;
    context.completionMessage = `Task failed: ${error.message}. Check session replay: ${sessionUrl}`;
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
    invoiceAmount:   context.invoiceAmount   ?? "unknown",
    invoiceItems:    context.invoiceItems    ?? "0",
    paymentAmount:   context.paymentAmount   ?? "$0.00",
    paymentItems:    context.paymentItems    ?? "0",
    batchNumber:     context.batchNumber     ?? "",
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
