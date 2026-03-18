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

    // ------------------------------------------------------------------
    // STEP 3 — Click Payments tab and FULLY deselect everything
    // ------------------------------------------------------------------
    console.log("\n[3] → Clicking Payments tab");
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
    if (!paymentsTabClicked) {
      console.log("    ⚠️  Payments tab not found — skipping");
    }
    await page.waitForTimeout(3000);

    // Aggressively deselect ALL checkboxes on Payments tab
    console.log("\n[4] → Deselecting ALL payments (aggressive)");
    const paymentsDeselected = await page.evaluate(() => {
      let deselectedCount = 0;

      // First try: uncheck the Select All / header checkbox
      const headerCb = document.querySelector(
        'thead input[type="checkbox"], th input[type="checkbox"]'
      ) as HTMLInputElement | null;
      if (headerCb && headerCb.checked) {
        headerCb.click();
        deselectedCount++;
      }

      // Second try: uncheck every single row checkbox
      const rowCbs = Array.from(
        document.querySelectorAll('tbody input[type="checkbox"]')
      ) as HTMLInputElement[];
      rowCbs.forEach(cb => {
        if (cb.checked) {
          cb.click();
          deselectedCount++;
        }
      });

      return deselectedCount;
    });
    console.log(`    ℹ️  Deselected ${paymentsDeselected} payment checkbox(es)`);
    await page.waitForTimeout(2000);

    // VERIFY: confirm zero payments are selected
    const paymentsStillSelected: number = await page.evaluate(() => {
      const cbs = Array.from(
        document.querySelectorAll('input[type="checkbox"]')
      ) as HTMLInputElement[];
      return cbs.filter(cb => cb.checked).length;
    });

    if (paymentsStillSelected > 0) {
      console.log(`    ⚠️  ${paymentsStillSelected} checkbox(es) still checked on Payments tab`);
      // Try one more time — click each checked one
      await page.evaluate(() => {
        const cbs = Array.from(
          document.querySelectorAll('input[type="checkbox"]:checked')
        ) as HTMLInputElement[];
        cbs.forEach(cb => cb.click());
      });
      await page.waitForTimeout(1000);
    } else {
      console.log("    ✅ All payments deselected — confirmed zero selected");
    }

    context.paymentsCleared = true;

    // Navigate AWAY then back to reset all state cleanly
    console.log("\n[4b] → Refreshing page to ensure clean state");
    await page.goto("https://misterquik.sera.tech/accounting/unbatched");
    await page.waitForTimeout(5000);

    // ------------------------------------------------------------------
    // STEP 5 — Click Invoices tab
    // ------------------------------------------------------------------
    console.log("\n[5] → Clicking Invoices tab");
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
      throw new Error(`Invoices tab not found. Visible: ${visibleItems.join(", ")}`);
    }
    await page.waitForTimeout(3000);

    // ------------------------------------------------------------------
    // STEP 6 — Count invoices using footer + "no matching" check
    // ------------------------------------------------------------------
    console.log("\n[6] → Counting invoices");
    await page.waitForTimeout(2000);

    const pageStatus: { noMatchingMsg: boolean; footerCount: number; tbodyRows: number } =
      await page.evaluate(() => {
        const bodyText = document.body.textContent || "";

        const noMatchingMsg =
          bodyText.toLowerCase().includes("no matching records") ||
          bodyText.toLowerCase().includes("no records found") ||
          bodyText.toLowerCase().includes("no results found");

        const footerMatch = bodyText.match(/(\d+)\s+results?/i);
        const footerCount = footerMatch ? parseInt(footerMatch[1], 10) : -1;

        const rows = Array.from(document.querySelectorAll("tbody tr"));
        const realRows = rows.filter(row => {
          const text = row.textContent?.trim() || "";
          return (
            text.length > 0 &&
            !text.toLowerCase().includes("no matching") &&
            !text.toLowerCase().includes("no records") &&
            !text.toLowerCase().includes("no results") &&
            !text.toLowerCase().includes("loading")
          );
        });

        return { noMatchingMsg, footerCount, tbodyRows: realRows.length };
      });

    console.log(`    ℹ️  No matching msg: ${pageStatus.noMatchingMsg}`);
    console.log(`    ℹ️  Footer count: ${pageStatus.footerCount}`);
    console.log(`    ℹ️  Tbody rows: ${pageStatus.tbodyRows}`);

    let invoiceCount = 0;
    if (pageStatus.noMatchingMsg) {
      invoiceCount = 0;
    } else if (pageStatus.footerCount === 0) {
      invoiceCount = 0;
    } else if (pageStatus.footerCount > 0) {
      invoiceCount = pageStatus.footerCount;
    } else {
      invoiceCount = pageStatus.tbodyRows;
    }

    console.log(`    ℹ️  Final invoice count: ${invoiceCount}`);
    context.invoiceCount = invoiceCount;

    // ------------------------------------------------------------------
    // NO INVOICES — return clean message immediately
    // ------------------------------------------------------------------
    if (invoiceCount === 0 || pageStatus.noMatchingMsg) {
      context.noInvoices = true;
      context.completionMessage = "No invoices found to batch. The Unbatched Invoices tab shows 'No matching records found'.";
      console.log("    ✅ No invoices to batch today");

    } else {
      // ------------------------------------------------------------------
      // STEP 7 — Select ALL invoices only (Invoices tab is active)
      // ------------------------------------------------------------------
      console.log(`\n[7] → Selecting all ${invoiceCount} invoices`);
      const selectAllClicked = await page.evaluate(() => {
        const cb = document.querySelector(
          "thead input[type='checkbox'], th input[type='checkbox']"
        ) as HTMLInputElement | null;
        if (cb) { cb.click(); return true; }
        return false;
      });
      if (!selectAllClicked) throw new Error("Select All checkbox not found on Invoices tab");
      await page.waitForTimeout(2000);

      // Read header bar totals AFTER selection
      // Page shows: "Total Invoices: $44,701.84   Total Payments: $0.00"
      const headerTotals: { invoiceTotal: string; paymentTotal: string } = await page.evaluate(() => {
        const bodyText = document.body.textContent || "";
        const invMatch = bodyText.match(/total invoices?[:\s]*\$?([\d,]+\.?\d*)/i);
        const payMatch = bodyText.match(/total payments?[:\s]*\$?([\d,]+\.?\d*)/i);
        return {
          invoiceTotal: invMatch ? `$${invMatch[1]}` : "N/A",
          paymentTotal: payMatch ? `$${payMatch[1]}` : "$0.00",
        };
      });
      console.log(`    ℹ️  Invoice total from header: ${headerTotals.invoiceTotal}`);
      console.log(`    ℹ️  Payment total from header: ${headerTotals.paymentTotal}`);
      context.invoiceTotal = headerTotals.invoiceTotal;
      context.paymentTotal = headerTotals.paymentTotal;

      // SAFETY CHECK — if header shows any payment amount selected, STOP
      const paymentTotalNum = parseFloat(
        headerTotals.paymentTotal.replace(/[$,]/g, "") || "0"
      );
      if (paymentTotalNum > 0) {
        throw new Error(
          `Header shows Total Payments: ${headerTotals.paymentTotal} — payments are selected. Aborting to avoid batching payments.`
        );
      }

      // ------------------------------------------------------------------
      // STEP 8 — Click Send to QuickBooks
      // ------------------------------------------------------------------
      console.log("\n[8] → Clicking Send to QuickBooks");
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
      // STEP 9 — Read modal details carefully
      // ------------------------------------------------------------------
      console.log("\n[9] → Reading batch modal");
      await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content, .sera-modal', 15000);
      await page.waitForTimeout(3000); // wait longer for modal to fully render

      const modalDetails: {
        batchNumber: string;
        invoiceAmount: string;
        invoiceItems: string;
        paymentAmount: string;
        paymentItems: string;
        paymentsCount: number;
        rawText: string;
      } = await page.evaluate(() => {
        const modal = document.querySelector(
          '.modal, [role="dialog"], .modal-content, .sera-modal'
        );
        const text = modal?.textContent || "";

        // Log raw text to console for debugging
        const rawText = text.replace(/\s+/g, " ").trim().substring(0, 500);

        // Batch number: "Batch #46495" or "#46495"
        const batchMatch = text.match(/#\s*(\d{4,})/i) ||
                           text.match(/batch\s*(?:number|num|#)?\s*(\d{4,})/i);

        // Invoice total: "$44,701.84" with "(26 items)" nearby
        const invAmountMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
        const invItemsMatch  = text.match(/(\d+)\s*(?:invoice)?s?\s*items?/i) ||
                               text.match(/(\d+)\s*invoices?/i);

        // Payment items/amount
        const payAmountMatch = text.match(/payments?.*?\$\s*([\d,]+\.\d{2})/i);
        const payItemsMatch  = text.match(/(\d+)\s*payments?/i);
        const payCount = payItemsMatch ? parseInt(payItemsMatch[1], 10) : 0;

        return {
          batchNumber:   batchMatch    ? batchMatch[1]     : "",
          invoiceAmount: invAmountMatch ? `$${invAmountMatch[1]}` : "",
          invoiceItems:  invItemsMatch  ? invItemsMatch[1]  : "",
          paymentAmount: payAmountMatch ? `$${payAmountMatch[1]}` : "$0.00",
          paymentItems:  payItemsMatch  ? payItemsMatch[1]  : "0",
          paymentsCount: payCount,
          rawText,
        };
      });

      // Always log raw modal text so we can see what the modal actually contains
      console.log(`\n    📋 Modal raw text:\n    ${modalDetails.rawText}\n`);
      console.log(`    ℹ️  Batch #: "${modalDetails.batchNumber}"`);
      console.log(`    ℹ️  Invoice amount: "${modalDetails.invoiceAmount}"`);
      console.log(`    ℹ️  Invoice items: "${modalDetails.invoiceItems}"`);
      console.log(`    ℹ️  Payment count: ${modalDetails.paymentsCount}`);

      // ABORT if modal shows any payments
      if (modalDetails.paymentsCount > 0) {
        throw new Error(
          `Modal shows ${modalDetails.paymentsCount} payment(s) — aborting. Only invoices should be batched.`
        );
      }
      console.log("    ✅ Verified — zero payments in batch");

      // Use modal values if found, fallback to header values
      const finalInvoiceAmount = modalDetails.invoiceAmount || context.invoiceTotal || "N/A";
      const finalInvoiceItems  = modalDetails.invoiceItems  || String(invoiceCount);
      const finalPaymentAmount = modalDetails.paymentAmount || "$0.00";
      const finalPaymentItems  = modalDetails.paymentItems  || "0";
      const batchLabel         = modalDetails.batchNumber
        ? `Batch #${modalDetails.batchNumber}`
        : "Batch";

      context.batchNumber   = modalDetails.batchNumber;
      context.invoiceAmount = finalInvoiceAmount;
      context.invoiceItems  = finalInvoiceItems;
      context.paymentAmount = finalPaymentAmount;
      context.paymentItems  = finalPaymentItems;

      // ------------------------------------------------------------------
      // STEP 10 — Click Create Batch
      // ------------------------------------------------------------------
      console.log("\n[10] → Clicking Create Batch");
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
        if (byText) { byText.click(); return true; }
        const fallback = scope.querySelector(
          'button[type="submit"], button.btn-primary, button.primary'
        ) as HTMLElement | null;
        if (fallback) { (fallback as HTMLElement).click(); return true; }
        return false;
      });
      if (!createBatchClicked) throw new Error('"Create Batch" button not found');
      await page.waitForTimeout(5000);

      // ------------------------------------------------------------------
      // STEP 11 — Wait for modal to close
      // ------------------------------------------------------------------
      console.log("\n[11] → Waiting for batch to complete");
      await waitUntilHidden(page, '.modal, [role="dialog"], .modal-content', 30000);

      context.batchCreated = true;
      context.completionMessage = [
        `**Invoice Processing:** Selected all ${invoiceCount} invoices on the 'Invoices' tab.`,
        `**Batch Creation:** Created ${batchLabel}.`,
        `   - **Total Invoices:** ${finalInvoiceAmount} (${finalInvoiceItems} items)`,
        `   - **Total Payments:** ${finalPaymentAmount} (${finalPaymentItems} items)`,
        `**Confirmation:** The batch is currently processing on the system.`,
      ].join("\n");

      console.log(`\n✅ Done:\n${context.completionMessage}`);
    }

  } catch (error: any) {
    console.error(`\n❌ Task error: ${error.message}`);
    context.taskError = error.message;
    context.completionMessage = `Task failed: ${error.message}. Session: ${sessionUrl}`;
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
    invoiceAmount:   context.invoiceAmount   ?? "N/A",
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
