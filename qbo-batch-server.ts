// qbo-batch-server.ts
// TEST MODE: POST /run-qbo-batch with body { "testInvoiceUrl": "https://..." }
// PROD MODE: POST /run-qbo-batch with empty body {}


import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// HELPERS
// =============================================================================

async function waitUntilVisible(page: any, selector: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.locator(selector).first().isVisible()) return true;
    } catch {}
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout: ${selector} not visible`);
}

async function waitUntilText(page: any, regex: RegExp, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const text = await page.evaluate(() => document.body.textContent || "");
    if (regex.test(text)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
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

    const checked = Array.from(
      document.querySelectorAll('tbody input[type="checkbox"]:checked')
    ) as HTMLInputElement[];

    checked.forEach(cb => cb.click());
    return checked.length;
  });
}

async function deselectPaymentsOnly(page: any): Promise<number> {
 
  // ── Step 1: Wait for the Payments header <th> to appear ─────────────────
  console.log("    → Waiting for payment table header...");
  await page.waitForSelector("th.payment_exports_report_header_null", {
    timeout: 60000,
  });
  console.log("    ✅ Payment table header found");
 
   // ── Step 2: Deselect via page.evaluate — scoped to Payments table only ──
    const deselectedCount: number = await page.evaluate(() => {
    // Find the <th> that only exists in the Payments table
    const paymentHeader = document.querySelector(
      "th.payment_exports_report_header_null"
    );
    if (!paymentHeader) {
      throw new Error("payment_exports_report_header_null th not found in DOM");
    }
 
    // Walk up to the parent <table>
    const table = paymentHeader.closest("table");
    if (!table) {
      throw new Error("Could not find parent <table> of payment header th");
    }
 
    // Try header checkbox first (clears all rows at once)
    const headerCb = paymentHeader.querySelector(
      "input.custom-checkbox"
    ) as HTMLInputElement | null;
 
    if (headerCb && !headerCb.disabled && headerCb.checked) {
      headerCb.click();
      return -1; // sentinel: header was clicked
    }
 
    // Deselect all checked row checkboxes scoped strictly to this table
    const checkedBoxes = Array.from(
      table.querySelectorAll("tbody input.custom-checkbox:checked")
    ) as HTMLInputElement[];
 
    checkedBoxes.forEach(cb => cb.click());
    return checkedBoxes.length;
  });
 
  if (deselectedCount === -1) {
    console.log("    ✅ Header checkbox clicked — all payment rows cleared");
    await page.waitForTimeout(500);
    return 1;
  }
 
  // If rows were individually deselected, allow Vue to settle
  if (deselectedCount > 0) {
    await page.waitForTimeout(deselectedCount * 150);
  }
 
  console.log(`    ✅ Deselected ${deselectedCount} payment row checkbox(es)`);
  return deselectedCount;
}
 
// async function clickTab(page: any, tab: "Invoices" | "Payments") {
//   return await page.evaluate((name: string) => {
//     const el = Array.from(
//       document.querySelectorAll("a, button, [role='tab'], li, span")
//     ).find(e =>
//       new RegExp(name, "i").test(e.textContent || "") &&
//       (e as HTMLElement).offsetParent !== null
//     ) as HTMLElement | null;

//     if (el) {
//       el.click();
//       return true;
//     }
//     return false;
//   }, tab);
// }

// =============================================================================
// MAIN TASK
// =============================================================================

async function runQBOBatchTask(options: { testInvoiceUrl?: string } = {}) {
  const email = process.env.SERA_EMAIL || "";
  const password = process.env.SERA_PASSWORD || "";

  const unbatchedUrl =
    options.testInvoiceUrl ||
    "https://misterquik.sera.tech/accounting/unbatched";

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY || "",
    },
    verbose: 1,
  });

  const context: any = {};
  let sessionUrl = "";

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;

    // =========================================================
    // LOGIN
    // =========================================================
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

    if (btn) {
      btn.click();
      return true;
    }
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

    if (i === 29) {
      throw new Error("Still on login page after 30s — check credentials");
    }
  }
} else {
  console.log("    ✅ Already logged in");
}

    // =========================================================
    // OPEN UNBATCHED
    // =========================================================
    console.log("\n[2] → Opening unbatched base page");
    await page.goto(unbatchedUrl);
    await page.waitForTimeout(15000);

   // ── If nothing to batch ──────────────────────────────────────
   const nothingToBatch = await waitUntilText(
   page,
   /total invoices:\s*none selected/i,
   5000
  ).catch(() => false);

  if (nothingToBatch) {
  return {
    success: true,
    message: "No matching records found",
    batchNumber: "N/A",
    invoiceAmount: "0",
    paymentAmount: "0",
    sessionUrl,
  };
}
    
    // =========================================================
    // PAYMENTS CLEANUP
    // =========================================================
       console.log("\n[3] → Switching to Payments tab");
    await page.goto(
      "https://misterquik.sera.tech/accounting/unbatched?tab=ub_Payments"
    );

    // Wait for full page + Vue render
    await page.waitForLoadState?.("networkidle");
    await page.waitForTimeout(20000);

    console.log("    → Deselecting all payments");
    // await deselectAllOnCurrentTab(page);
    await deselectPaymentsOnly(page);

    const paymentsCleared = await waitUntilText(
      page,
      /total payments:\s*none selected/i,
      60000
    );

    if (!paymentsCleared) {
      throw new Error("Payments not cleared properly");
    }

    context.paymentsCleared = true;

    await page.waitForTimeout(10000);

    // =========================================================
    // INVOICES TAB (NO SELECTION)
    // =========================================================
    // await clickTab(page, "Invoices");
    // await page.waitForTimeout(3000);

    // =========================================================
    // SEND TO QUICKBOOKS (YOUR EXACT LOGIC)
    // =========================================================
    console.log("\n[8] → Clicking Send to QuickBooks");

    const qbClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("button, a")).find(
        (e) =>
          (e.textContent?.toLowerCase().includes("send to quickbooks") ||
            e.textContent?.toLowerCase().includes("quickbooks")) &&
          (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;

      if (el) {
        el.click();
        return true;
      }
      return false;
    });

    if (!qbClicked) throw new Error('"Send to QuickBooks" button not found');

    await page.waitForTimeout(3000);

    // =========================================================
    // READ MODAL
    // =========================================================
    await waitUntilVisible(page, '.modal, [role="dialog"]');

    const modal = await page.evaluate(() => {
    const el = document.querySelector('.modal, [role="dialog"]');
    if (!el) return null;

    const text = el.textContent?.replace(/\s+/g, " ").trim() || "";

    const invoiceItemsMatch  = text.match(/Total Invoices\s*\((\d+)\)/i);
    const invoiceAmountMatch = text.match(/Total Invoices[^$]*\$([\d,.]+)/i);
    const paymentItemsMatch  = text.match(/Total Payments\s*\((\d+)\)/i);
    const paymentAmountMatch = text.match(/Total Payments[^$]*\$([\d,.]+)/i);

    const batchInput = el.querySelector('[data-cy="batch-name"]') as HTMLInputElement | null;
    const batchNumber = batchInput?.value?.trim() || "";  

    return {
    batchNumber,
    invoiceItems:  invoiceItemsMatch?.[1]  || "0",
    invoiceAmount: invoiceAmountMatch?.[1] || "0",
    paymentItems:  paymentItemsMatch?.[1]  || "0",
    paymentAmount: paymentAmountMatch?.[1] || "0",
    };
   });

    if (!modal) {
    throw new Error("Modal not found — Send to QuickBooks dialog did not open");
   }
   console.log(`    → Modal parsed: items_inv=${modal.invoiceItems} amt_inv=${modal.invoiceAmount} items_pay=${modal.paymentItems} amt_pay=${modal.paymentAmount} batch=${modal.batchNumber}`);

   if (Number(modal.paymentItems) > 0) {
   throw new Error("Payments found in batch — aborting");
   }

    const createClicked = await page.evaluate(() => {
    const btn = Array.from(
    document.querySelectorAll('.modal button, [role="dialog"] button')
    ).find(
    (el) => el.textContent?.toLowerCase().includes("create batch") &&
            (el as HTMLElement).offsetParent !== null
    ) as HTMLElement | null;
    if (btn) { btn.click(); return true; }
    return false;
    });

    if (!createClicked) throw new Error('"Create Batch" button not found in modal');
    await page.waitForTimeout(5000);

    context.batchCreated = true;
    context.batchNumber = modal.batchNumber;
    context.invoiceAmount = modal.invoiceAmount;
    context.paymentAmount = modal.paymentAmount;

    // =========================================================
    // FINAL MESSAGE (UPDATED)
    // =========================================================
    context.completionMessage = `
    Batch Created Successfully
    - Batch #: ${modal.batchNumber}
    - Invoice Items: ${modal.invoiceItems}
    - Invoice Amount: $${modal.invoiceAmount}
    - Payment Items: ${modal.paymentItems}
    - Payment Amount: $${modal.paymentAmount}
    `;

    await page.waitForTimeout(5000);

  } catch (err: any) {
    context.error = err.message;
    context.completionMessage = `Failed: ${err.message}`;
  } finally {
    await stagehand.close();
  }

  return {
    success: !!context.batchCreated,
    message: context.completionMessage,
    batchNumber: context.batchNumber || "",
    invoiceAmount: context.invoiceAmount || "0",
    paymentAmount: context.paymentAmount || "0",
    sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

const jobs = new Map();

app.post("/run-qbo-batch", (req, res) => {
  const jobId = "job_" + Date.now();

  jobs.set(jobId, { status: "running" });

  runQBOBatchTask(req.body)
    .then(result => jobs.set(jobId, { status: "done", result }))
    .catch(err => jobs.set(jobId, { status: "failed", error: err.message }));

  res.json({ jobId });
});

app.get("/job-status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

app.listen(3000, () => {
  console.log("QBO server running on port 3000");
});
