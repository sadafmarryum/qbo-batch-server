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

// async function deselectPaymentsOnly(page: any): Promise<number> {
//   return await page.evaluate(() => {
//     const paymentsSection =
//       document.querySelector('[data-tab="ub_Payments"]') ||
//       document.querySelector('[aria-label*="Payments"]') ||
//       document.querySelector('.payments') ||
//       document.body; // fallback

//     const headerCb = paymentsSection.querySelector(
//       'thead input[type="checkbox"], th input[type="checkbox"]'
//     ) as HTMLInputElement | null;

//     if (headerCb?.checked) {
//       headerCb.click();
//     }

//     const checked = Array.from(
//       paymentsSection.querySelectorAll('tbody input[type="checkbox"]:checked')
//     ) as HTMLInputElement[];

//     checked.forEach(cb => cb.click());

//     return checked.length;
//   });
// }

// async function deselectPaymentsOnly(page: any): Promise<number> {
//   return await page.evaluate(() => {
//     // find ONLY visible table (Payments tab renders one active grid)
//     const tables = Array.from(document.querySelectorAll("table"));

//     const visibleTable = tables.find(t => {
//       const style = window.getComputedStyle(t);
//       return style.display !== "none" && style.visibility !== "hidden";
//     });

//     if (!visibleTable) return 0;

//     // header checkbox (select all in THIS table only)
//     const headerCb = visibleTable.querySelector(
//       'thead input[type="checkbox"], th input[type="checkbox"]'
//     ) as HTMLInputElement | null;

//     if (headerCb?.checked) {
//       headerCb.click();
//     }

//     // row checkboxes ONLY in this table
//     const checked = Array.from(
//       visibleTable.querySelectorAll('tbody input[type="checkbox"]:checked')
//     ) as HTMLInputElement[];

//     checked.forEach(cb => cb.click());

//     return checked.length;
//   });
// }



async function deselectPaymentsOnly(page: any): Promise<number> {

  // ── Step 1: Confirm the Payments tab is actually active ──────────────────
  const activeTab = page.locator('[data-cy="tab-Payments"] .nav-link.active');
  if ((await activeTab.count()) === 0) {
    throw new Error(
      "Payments tab is not active — cannot safely scope deselection"
    );
  }

  // ── Step 2: Locate the Payments panel container ──────────────────────────
  // data-cy naming conventions vary per app; try most-likely patterns first.
  const panelCandidates = [
    '[data-cy="panel-Payments"]',
    '[data-cy="tabpanel-Payments"]',
    '[data-cy="content-Payments"]',
    '[data-cy="tab-Payments"] ~ div',   // immediate sibling of tab container
    '[data-cy="tab-Payments"] + div',
  ];

  let panel: any = null;

  for (const sel of panelCandidates) {
    const loc = page.locator(sel);
    if ((await loc.count()) > 0 && (await loc.first().isVisible())) {
      panel = loc.first();
      console.log(`    ✅ Payments panel found via: ${sel}`);
      break;
    }
  }

  // ── Step 3: Fallback — climb up from the active nav-link and find table ──
  if (!panel) {
    console.log(
      "    ⚠️  No data-cy panel found — using nav-link.active parent strategy"
    );

    // [data-cy="tab-Payments"] → parent → descendant table
    panel = page
      .locator('[data-cy="tab-Payments"]')
      .locator("..")       // one level up from tab group
      .locator(">> table") // first visible table descendant
      .first();
  }

  if (!panel || (await panel.count()) === 0) {
    // ── DOM Diagnostic before throwing ──────────────────────────────────────
    const debug = await page.evaluate(() => {
      const tab = document.querySelector('[data-cy="tab-Payments"]');
      if (!tab) return "data-cy=tab-Payments not found in DOM";

      const parent = tab.parentElement;
      return {
        tabOuterHTML: tab.outerHTML.slice(0, 300),
        parentTag: parent?.tagName,
        parentId: parent?.id,
        parentDataCy: parent?.getAttribute("data-cy"),
        siblings: Array.from(parent?.children || []).map(el => ({
          tag: el.tagName,
          id: (el as HTMLElement).id,
          dataCy: el.getAttribute("data-cy"),
          class: el.className.slice(0, 80),
        })),
      };
    });
    console.error("DOM diagnostic:", JSON.stringify(debug, null, 2));
    throw new Error(
      "Could not locate Payments panel — check DOM diagnostic output above"
    );
  }

  // ── Step 4: Deselect header checkbox first (clears all rows at once) ─────
  const headerCb = panel
    .locator('thead input[type="checkbox"], th input[type="checkbox"]')
    .first();

  if ((await headerCb.count()) > 0 && (await headerCb.isChecked())) {
    await headerCb.click();
    await page.waitForTimeout(500); // let Vue reactivity settle
    console.log("    ✅ Header checkbox deselected — all payments cleared");
    return 1;
  }

  // ── Step 5: Deselect individual checked rows (re-query each time) ─────────
  // Re-querying prevents stale handles after Vue re-renders the list.
  let deselectedCount = 0;

  while (true) {
    const checked = panel
      .locator('tbody input[type="checkbox"]:checked')
      .first();

    if ((await checked.count()) === 0) break;

    await checked.click();
    await page.waitForTimeout(150);
    deselectedCount++;
  }

  console.log(`    ✅ Deselected ${deselectedCount} payment row(s)`);
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

    // =========================================================
    // PAYMENTS CLEANUP
    // =========================================================
       console.log("\n[3] → Switching to Payments tab");
    await page.goto(
      "https://misterquik.sera.tech/accounting/unbatched?tab=ub_Payments"
    );

    // Wait for full page + Vue render
    await page.waitForLoadState?.("networkidle");
    await page.waitForTimeout(15000);

    // Wait until at least one checkbox is in the DOM
    await page.waitForSelector('tbody input[type="checkbox"]', {
      timeout: 30000,
    });

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

    await page.waitForTimeout(2 * 60 * 1000);

    // =========================================================
    // INVOICES TAB (NO SELECTION)
    // =========================================================
    // await clickTab(page, "Invoices");
    // await page.waitForTimeout(3000);


    // =========================================================
// TEST STOP HERE (SAFE DEBUG MODE)
// =========================================================
context.batchCreated = true;

context.completionMessage = `
✅ TEST SUCCESS

Invoices tab opened successfully.
No selection / QBO action executed.

You can verify UI state from session URL.
`;

await page.waitForTimeout(2000);

    
    // =========================================================
    // SEND TO QUICKBOOKS (YOUR EXACT LOGIC)
    // =========================================================
    // console.log("\n[8] → Clicking Send to QuickBooks");

    // const qbClicked = await page.evaluate(() => {
    //   const el = Array.from(document.querySelectorAll("button, a")).find(
    //     (e) =>
    //       (e.textContent?.toLowerCase().includes("send to quickbooks") ||
    //         e.textContent?.toLowerCase().includes("quickbooks")) &&
    //       (e as HTMLElement).offsetParent !== null
    //   ) as HTMLElement | null;

    //   if (el) {
    //     el.click();
    //     return true;
    //   }
    //   return false;
    // });

    // if (!qbClicked) throw new Error('"Send to QuickBooks" button not found');

    // await page.waitForTimeout(3000);

    // =========================================================
    // READ MODAL
    // =========================================================
    // await waitUntilVisible(page, '.modal, [role="dialog"]');

    // const modal = await page.evaluate(() => {
    //   const el = document.querySelector('.modal, [role="dialog"]');
    //   const text = el?.textContent || "";

    //   const invoiceMatch = text.match(/invoices?.*?\$([\d,.]+)/i);
    //   const invoiceItems = text.match(/invoices?.*?(\d+)\s*items/i);

    //   const paymentMatch = text.match(/payments?.*?\$([\d,.]+)/i);
    //   const paymentItems = text.match(/payments?.*?(\d+)\s*items/i);

    //   const batch = text.match(/batch\s*#?\s*(\d+)/i);

    //   return {
    //     batchNumber: batch?.[1] || "",
    //     invoiceAmount: invoiceMatch?.[1] || "0",
    //     invoiceItems: invoiceItems?.[1] || "0",
    //     paymentAmount: paymentMatch?.[1] || "0",
    //     paymentItems: paymentItems?.[1] || "0",
    //   };
    // });
// -----------------New
// const modal = await page.evaluate(() => {
//   const el = document.querySelector('.modal, [role="dialog"]');
//   if (!el) return null;

//   const getText = (node: Element | null) =>
//     node?.textContent?.replace(/\s+/g, " ").trim() || "";

//   // helper: find label element and grab nearby value
//   const findValueByLabel = (label: string) => {
//     const nodes = Array.from(el.querySelectorAll("*"));

//     const index = nodes.findIndex(n =>
//       n.textContent?.includes(label)
//     );

//     if (index === -1) return { amount: "0", items: "0" };

//     const labelNode = nodes[index];

//     // scan nearby nodes (UI is row-based)
//     const nearby = nodes.slice(index, index + 6)
//       .map(n => n.textContent?.trim() || "");

//     const amount = nearby.find(t => /\$\d/.test(t)) || "0";
//     const itemsMatch = nearby.find(t => /\(\d+\)/);

//     const items = itemsMatch?.match(/\((\d+)\)/)?.[1] || "0";

//     return {
//       amount: amount.replace(/[^\d.,$]/g, ""),
//       items
//     };
//   };

//   const invoice = findValueByLabel("Total Invoices");
//   const payment = findValueByLabel("Total Payments");

//   const batchNode = Array.from(el.querySelectorAll("*"))
//     .find(n => /batch/i.test(n.textContent || "") && /\d+/.test(n.textContent || ""));

//   const batchNumber =
//     batchNode?.textContent?.match(/(\d{3,})/)?.[1] || "";

//   return {
//     batchNumber,
//     invoiceAmount: invoice.amount,
//     invoiceItems: invoice.items,
//     paymentAmount: payment.amount,
//     paymentItems: payment.items,
//   };
// });

    
//    // ---------- 
//     // HARD SAFETY CHECK
//     if (Number(modal.paymentItems) > 0) {
//       throw new Error("Payments found in batch — aborting");
//     }

//     context.batchCreated = true;
//     context.batchNumber = modal.batchNumber;
//     context.invoiceAmount = modal.invoiceAmount;
//     context.paymentAmount = modal.paymentAmount;

//     // =========================================================
//     // FINAL MESSAGE (UPDATED)
//     // =========================================================
//     context.completionMessage = `
// Batch Created Successfully
// - Batch #: ${modal.batchNumber}
// - Invoice Items: ${modal.invoiceItems}
// - Invoice Amount: $${modal.invoiceAmount}
// - Payment Items: ${modal.paymentItems}
// - Payment Amount: $${modal.paymentAmount}
// `;

//     await page.waitForTimeout(5000);

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
