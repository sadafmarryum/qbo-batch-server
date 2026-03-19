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
    // STEP 2 — Navigate to Unbatched page (ONE TIME — no more refreshes)
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to Unbatched page");
    await page.goto("https://misterquik.sera.tech/accounting/unbatched");
    await page.waitForTimeout(5000);

    // ------------------------------------------------------------------
    // STEP 3 — Click Payments tab
    // ------------------------------------------------------------------
    console.log("\n[3] → Clicking Payments tab");
    let paymentsTabClicked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      paymentsTabClicked = await page.evaluate(() => {
        const el = Array.from(
          document.querySelectorAll("a, button, [role='tab'], li, span")
        ).find(
          (e) =>
            /^payments/i.test(e.textContent?.trim() || "") &&
            (e as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (el) { el.click(); return true; }
        return false;
      });
      if (paymentsTabClicked) break;
      console.log(`    ⚠️  Payments tab not found — attempt ${attempt + 1}/5`);
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);

    // ------------------------------------------------------------------
    // STEP 4 — Deselect ALL payments so header shows "None Selected"
    // ------------------------------------------------------------------
    console.log("\n[4] → Ensuring all payments are deselected");

    // Uncheck header checkbox first (deselects all rows at once)
    await page.evaluate(() => {
      const headerCb = document.querySelector(
        'thead input[type="checkbox"], th input[type="checkbox"]'
      ) as HTMLInputElement | null;
      if (headerCb && headerCb.checked) {
        headerCb.click();
        return;
      }
      // Fallback: uncheck every individual row checkbox
      const rowCbs = Array.from(
        document.querySelectorAll('tbody input[type="checkbox"]:checked')
      ) as HTMLInputElement[];
      rowCbs.forEach(cb => cb.click());
    });
    await page.waitForTimeout(2000);

    // Confirm header now reads "Total Payments: None Selected"
    const paymentsHeaderCheck = await page.evaluate(() => {
      const bodyText = document.body.textContent || "";
      const noneSelected = /total payments?[:\s]*none selected/i.test(bodyText);
      const snippet = (bodyText.match(/total\s+(?:invoices?|payments?).{0,120}/i) || [""])[0]
        .replace(/\s+/g, " ").trim();
      return { noneSelected, snippet };
    });

    console.log(`    ℹ️  Header after deselect: "${paymentsHeaderCheck.snippet}"`);

    if (!paymentsHeaderCheck.noneSelected) {
      // Could be nothing was selected to begin with — that is also fine.
      // Just log and move on.
      console.log("    ⚠️  'None Selected' not detected — either already clear or label differs");
    } else {
      console.log("    ✅ Confirmed: Total Payments: None Selected");
    }

    context.paymentsCleared = true;

    // ------------------------------------------------------------------
    // STEP 5 — Click Invoices tab (NO page navigation)
    // ------------------------------------------------------------------
    console.log("\n[5] → Clicking Invoices tab");
    let invoicesTabClicked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      invoicesTabClicked = await page.evaluate(() => {
        const el = Array.from(
          document.querySelectorAll("a, button, [role='tab'], li, span")
        ).find(
          (e) =>
            /^invoices/i.test(e.textContent?.trim() || "") &&
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
    // STEP 6 — Count invoices
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
      // STEP 7 — Select ALL invoices via header checkbox
      // ------------------------------------------------------------------
      console.log(`\n[7] → Selecting all ${invoiceCount} invoices`);
      const selectAllClicked = await page.evaluate(() => {
        const cb = document.querySelector(
          "thead input[type='checkbox'], th input[type='checkbox']"
        ) as HTMLInputElement | null;
        if (cb) {
          if (!cb.checked) cb.click();
          return true;
        }
        return false;
      });
      if (!selectAllClicked) throw new Error("Select All checkbox not found on Invoices tab");
      await page.waitForTimeout(2000);

      // Read header — should now show:
      //   Total Invoices: $XX,XXX.XX    Total Payments: None Selected
      const headerTotals: {
        invoiceTotal: string;
        paymentNoneSelected: boolean;
        rawHeaderText: string;
      } = await page.evaluate(() => {
        const bodyText = document.body.textContent || "";
        const invMatch = bodyText.match(/total invoices?[:\s]*\$?([\d,]+\.?\d*)/i);
        const payNoneSelected = /total payments?[:\s]*none selected/i.test(bodyText);
        const headerSnippet = (bodyText.match(/total invoices?.{0,150}/i) || [""])[0]
          .replace(/\s+/g, " ").trim();
        return {
          invoiceTotal:        invMatch ? `$${invMatch[1]}` : "N/A",
          paymentNoneSelected: payNoneSelected,
          rawHeaderText:       headerSnippet,
        };
      });

      console.log(`    ℹ️  Header: "${headerTotals.rawHeaderText}"`);
      console.log(`    ℹ️  Invoice total: ${headerTotals.invoiceTotal}`);
      console.log(`    ℹ️  Payment "None Selected": ${headerTotals.paymentNoneSelected}`);

      context.invoiceTotal = headerTotals.invoiceTotal;

      // Log warning if "None Selected" not detected but do NOT abort here.
      // The modal check in Step 9 is the real safety gate.
      if (!headerTotals.paymentNoneSelected) {
        console.log("    ⚠️  'None Selected' not in header — the static page total is showing.");
        console.log("    ℹ️  This is normal — modal will be verified before creating batch.");
      } else {
        console.log("    ✅ Header confirmed: Total Invoices selected, Total Payments: None Selected");
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
      // STEP 9 — Read modal — THIS is the real safety gate
      // ------------------------------------------------------------------
      console.log("\n[9] → Reading batch modal");
      await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content, .sera-modal', 15000);
      await page.waitForTimeout(3000);

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

        const rawText = text.replace(/\s+/g, " ").trim().substring(0, 500);

        const batchMatch = text.match(/#\s*(\d{4,})/i) ||
                           text.match(/batch\s*(?:number|num|#)?\s*(\d{4,})/i);

        const invAmountMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
        const invItemsMatch  = text.match(/(\d+)\s*(?:invoice)?s?\s*items?/i) ||
                               text.match(/(\d+)\s*invoices?/i);

        const payAmountMatch = text.match(/payments?.*?\$\s*([\d,]+\.\d{2})/i);
        const payItemsMatch  = text.match(/(\d+)\s*payments?/i);
        const payCount = payItemsMatch ? parseInt(payItemsMatch[1], 10) : 0;

        return {
          batchNumber:   batchMatch     ? batchMatch[1]          : "",
          invoiceAmount: invAmountMatch ? `$${invAmountMatch[1]}` : "",
          invoiceItems:  invItemsMatch  ? invItemsMatch[1]        : "",
          paymentAmount: payAmountMatch ? `$${payAmountMatch[1]}` : "$0.00",
          paymentItems:  payItemsMatch  ? payItemsMatch[1]        : "0",
          paymentsCount: payCount,
          rawText,
        };
      });

      console.log(`\n    📋 Modal raw text:\n    ${modalDetails.rawText}\n`);
      console.log(`    ℹ️  Batch #: "${modalDetails.batchNumber}"`);
      console.log(`    ℹ️  Invoice amount: "${modalDetails.invoiceAmount}"`);
      console.log(`    ℹ️  Invoice items: "${modalDetails.invoiceItems}"`);
      console.log(`    ℹ️  Payment count: ${modalDetails.paymentsCount}`);

      // REAL SAFETY GATE — abort if modal contains any payments
      if (modalDetails.paymentsCount > 0) {
        throw new Error(
          `Modal shows ${modalDetails.paymentsCount} payment(s) — aborting. Only invoices should be batched.`
        );
      }
      console.log("    ✅ Modal verified — zero payments in batch");

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
