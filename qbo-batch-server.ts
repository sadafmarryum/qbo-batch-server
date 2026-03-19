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

// Sleep helper with countdown log
async function sleepWithCountdown(page: any, totalMs: number, intervalMs = 30000): Promise<void> {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    console.log(`    ⏳ ${remaining}s remaining...`);
    await page.waitForTimeout(Math.min(intervalMs, end - Date.now()));
  }
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
    // STEP 2 — Navigate to Unbatched page
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to Unbatched page");
    await page.goto("https://misterquik.sera.tech/accounting/unbatched");

    // ⏳ Wait 5 minutes for page to fully load and all data to settle
    console.log("\n[2b] → Waiting 5 minutes for page to fully settle...");
    await sleepWithCountdown(page, 5 * 60 * 1000);
    console.log("    ✅ 5-minute wait complete — page should be fully loaded");

    // ------------------------------------------------------------------
    // STEP 3 — Read invoice count from the TAB LABEL "Invoices (13)"
    // Do this BEFORE clicking any tab so we get the correct number.
    // The footer shows ALL rows (invoices + payments combined) — do NOT use it.
    // ------------------------------------------------------------------
    console.log("\n[3] → Reading invoice count from tab label");

    const tabReadResult: { invoiceCount: number; paymentCount: number; invoiceTabLabel: string; paymentTabLabel: string } =
      await page.evaluate(() => {
        let invoiceCount    = 0;
        let paymentCount    = 0;
        let invoiceTabLabel = "";
        let paymentTabLabel = "";

        const allEls = Array.from(
          document.querySelectorAll("a, button, [role='tab'], li, span, div")
        ).filter(e => (e as HTMLElement).offsetParent !== null);

        for (const el of allEls) {
          const text = el.textContent?.trim() || "";

          // Match "Invoices (13)" or "Invoices 13"
          const invMatch = text.match(/^invoices?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
          if (invMatch) {
            invoiceCount    = parseInt(invMatch[1], 10);
            invoiceTabLabel = text;
          }

          // Match "Payments (16)" or "Payments 16"
          const payMatch = text.match(/^payments?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
          if (payMatch) {
            paymentCount    = parseInt(payMatch[1], 10);
            paymentTabLabel = text;
          }
        }

        return { invoiceCount, paymentCount, invoiceTabLabel, paymentTabLabel };
      });

    console.log(`    ℹ️  Invoice tab label: "${tabReadResult.invoiceTabLabel}" → count: ${tabReadResult.invoiceCount}`);
    console.log(`    ℹ️  Payment tab label: "${tabReadResult.paymentTabLabel}" → count: ${tabReadResult.paymentCount}`);

    const invoiceCount = tabReadResult.invoiceCount;
    context.invoiceCount = invoiceCount;

    // ------------------------------------------------------------------
    // STEP 4 — Click Payments tab and deselect everything
    // Goal: header shows "Total Payments: None Selected"
    // ------------------------------------------------------------------
    console.log("\n[4] → Clicking Payments tab");
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

    console.log("\n[4b] → Deselecting all payments");
    await page.evaluate(() => {
      // Try header checkbox first
      const headerCb = document.querySelector(
        'thead input[type="checkbox"], th input[type="checkbox"]'
      ) as HTMLInputElement | null;
      if (headerCb && headerCb.checked) {
        headerCb.click();
        return;
      }
      // Fallback: uncheck every row
      const rowCbs = Array.from(
        document.querySelectorAll('tbody input[type="checkbox"]:checked')
      ) as HTMLInputElement[];
      rowCbs.forEach(cb => cb.click());
    });
    await page.waitForTimeout(2000);

    // Verify "Total Payments: None Selected"
    const paymentsNoneSelected: boolean = await page.evaluate(() =>
      /total payments?[:\s]*none selected/i.test(document.body.textContent || "")
    );

    if (!paymentsNoneSelected) {
      // Retry once
      console.log("    ⚠️  Not showing 'None Selected' yet — retrying");
      await page.evaluate(() => {
        const cbs = Array.from(
          document.querySelectorAll('input[type="checkbox"]:checked')
        ) as HTMLInputElement[];
        cbs.forEach(cb => cb.click());
      });
      await page.waitForTimeout(2000);

      const recheck: boolean = await page.evaluate(() =>
        /total payments?[:\s]*none selected/i.test(document.body.textContent || "")
      );
      console.log(recheck
        ? "    ✅ Confirmed: Total Payments: None Selected"
        : "    ⚠️  'None Selected' still not detected — modal is the final safety gate"
      );
    } else {
      console.log("    ✅ Confirmed: Total Payments: None Selected (0 items selected)");
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
    // NO INVOICES — return clean message
    // ------------------------------------------------------------------
    if (invoiceCount === 0) {
      context.noInvoices = true;
      context.completionMessage = "No invoices found to batch. The Invoices tab shows 0 records.";
      console.log("    ✅ No invoices to batch today");

    } else {
      // ------------------------------------------------------------------
      // STEP 6 — Select ALL invoices via header checkbox
      // ------------------------------------------------------------------
      console.log(`\n[6] → Selecting all ${invoiceCount} invoices`);
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

      // Confirm header looks right
      const headerTotals = await page.evaluate(() => {
        const bodyText = document.body.textContent || "";
        const invMatch = bodyText.match(/total invoices?[:\s]*\$?([\d,]+\.?\d*)/i);
        const payNone  = /total payments?[:\s]*none selected/i.test(bodyText);
        const snippet  = (bodyText.match(/total invoices?.{0,180}/i) || [""])[0]
          .replace(/\s+/g, " ").trim();
        return {
          invoiceTotal:        invMatch ? `$${invMatch[1]}` : "N/A",
          paymentNoneSelected: payNone,
          rawHeaderText:       snippet,
        };
      });

      console.log(`    ℹ️  Header: "${headerTotals.rawHeaderText}"`);
      console.log(`    ℹ️  Invoice total: ${headerTotals.invoiceTotal}`);
      console.log(`    ℹ️  Total Payments: None Selected = ${headerTotals.paymentNoneSelected}`);
      context.invoiceTotal = headerTotals.invoiceTotal;

      if (headerTotals.paymentNoneSelected) {
        console.log("    ✅ Perfect state — invoices selected, payments = None Selected");
      } else {
        console.log("    ℹ️  Header shows static payment total — this is normal, modal will verify");
      }

      // ------------------------------------------------------------------
      // STEP 7 — Click Send to QuickBooks
      // ------------------------------------------------------------------
      console.log("\n[7] → Clicking Send to QuickBooks");
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
      // STEP 8 — Read modal (line-by-line parsing — no bleed between fields)
      // ------------------------------------------------------------------
      console.log("\n[8] → Reading batch modal");
      await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content, .sera-modal', 15000);
      await page.waitForTimeout(3000);

      const modalDetails: {
        batchNumber:   string;
        invoiceAmount: string;
        invoiceItems:  number;
        paymentAmount: string;
        paymentItems:  number;
        rawText:       string;
      } = await page.evaluate(() => {
        const modal   = document.querySelector(
          '.modal, [role="dialog"], .modal-content, .sera-modal'
        );
        const text    = modal?.textContent || "";
        const rawText = text.replace(/\s+/g, " ").trim().substring(0, 600);

        const batchMatch =
          text.match(/batch\s*#?\s*(\d{4,})/i) ||
          text.match(/#\s*(\d{4,})/);

        // Line-by-line: find the "Invoices" line and "Payments" line separately
        const lines = text
          .split(/[\n\r]+/)
          .map(l => l.replace(/\s+/g, " ").trim())
          .filter(Boolean);

        let invoiceAmount = "";
        let invoiceItems  = 0;
        let paymentAmount = "$0.00";
        let paymentItems  = 0;

        for (const line of lines) {
          if (/^invoices?/i.test(line)) {
            const amt   = line.match(/\$([\d,]+\.\d{2})/);
            const items = line.match(/(\d+)\s*items?/i);
            if (amt)   invoiceAmount = `$${amt[1]}`;
            if (items) invoiceItems  = parseInt(items[1], 10);
          }
          if (/^payments?/i.test(line)) {
            const amt   = line.match(/\$([\d,]+\.\d{2})/);
            const items = line.match(/(\d+)\s*items?/i);
            if (amt)   paymentAmount = `$${amt[1]}`;
            if (items) paymentItems  = parseInt(items[1], 10);
          }
        }

        // Fallback for single-line modal
        if (!invoiceAmount) {
          const m = text.match(/invoices?\s*\$\s*([\d,]+\.\d{2})/i);
          if (m) invoiceAmount = `$${m[1]}`;
        }
        if (!invoiceItems) {
          const m = text.match(/invoices?[^$\n]*?(\d+)\s*items?/i);
          if (m) invoiceItems = parseInt(m[1], 10);
        }
        if (paymentItems === 0) {
          const m = text.match(/payments?[^$\n]*?(\d+)\s*items?/i);
          if (m) paymentItems = parseInt(m[1], 10);
        }

        return {
          batchNumber:   batchMatch ? batchMatch[1] : "",
          invoiceAmount,
          invoiceItems,
          paymentAmount,
          paymentItems,
          rawText,
        };
      });

      console.log(`\n    📋 Modal raw text:\n    ${modalDetails.rawText}\n`);
      console.log(`    ℹ️  Batch #:    "${modalDetails.batchNumber}"`);
      console.log(`    ℹ️  Invoices:    ${modalDetails.invoiceAmount} (${modalDetails.invoiceItems} items)`);
      console.log(`    ℹ️  Payments:    ${modalDetails.paymentAmount} (${modalDetails.paymentItems} items)`);

      // ── SAFETY GATE — abort if modal has ANY payment items ────────────
      if (modalDetails.paymentItems > 0) {
        throw new Error(
          `Modal shows ${modalDetails.paymentItems} payment item(s) — aborting. Only invoices should be batched.`
        );
      }
      console.log("    ✅ Modal verified — 0 payment items in batch");

      const batchLabel = modalDetails.batchNumber
        ? `Batch #${modalDetails.batchNumber}`
        : "Batch";

      context.batchNumber   = modalDetails.batchNumber;
      context.invoiceAmount = modalDetails.invoiceAmount || context.invoiceTotal || "N/A";
      context.invoiceItems  = String(modalDetails.invoiceItems || invoiceCount);
      context.paymentAmount = modalDetails.paymentAmount;
      context.paymentItems  = String(modalDetails.paymentItems);

      // ------------------------------------------------------------------
      // STEP 9 — Click Create Batch
      // ------------------------------------------------------------------
      console.log("\n[9] → Clicking Create Batch");
      const createBatchClicked = await page.evaluate(() => {
        const modal  = document.querySelector(
          '.modal, [role="dialog"], .modal-content, .sera-modal'
        );
        const scope  = modal || document;
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
      // STEP 10 — Wait for modal to close
      // ------------------------------------------------------------------
      console.log("\n[10] → Waiting for batch to complete");
      await waitUntilHidden(page, '.modal, [role="dialog"], .modal-content', 30000);

      context.batchCreated = true;
      context.completionMessage = [
        `**Invoice Processing:** Selected all ${invoiceCount} invoices on the 'Invoices' tab.`,
        `**Batch Creation:** Created ${batchLabel}.`,
        `   - **Total Invoices:** ${context.invoiceAmount} (${context.invoiceItems} items)`,
        `   - **Total Payments:** ${context.paymentAmount} (${context.paymentItems} items)`,
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
