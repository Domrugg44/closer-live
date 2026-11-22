// What a visitor should always be able to do on Closer. These tests avoid depending on specific games or
// numbers (those change every day), so a failure means something is actually broken.
const { test, expect } = require("@playwright/test");

const VIEWS = ["", "#picks", "#live", "#slip", "#results"];

// Every test collects JavaScript errors from the moment the page opens, and at the end waits for the page to
// settle (data loaded, network quiet) before checking there were none. Errors can arrive after the first paint.
const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = []; pageErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(e.message));
});
test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
  expect(pageErrors.get(page), "no JavaScript errors").toEqual([]);
});

// open a view and wait until the pick log has loaded
async function open(page, hash = "") {
  await page.goto("./" + hash);
  await page.waitForFunction(() => typeof rec !== "undefined" && rec && Array.isArray(rec.entries), null, { timeout: 30_000 });
  return pageErrors.get(page);
}

test.describe("every page", () => {
  for (const v of VIEWS) {
    test(`${v || "dashboard"} loads without errors and fits the screen`, async ({ page }) => {
      await open(page, v);
      const id = "v-" + (v ? v.slice(1) : "dash");
      await expect(page.locator(`#${id}`)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "page should not scroll sideways").toBeLessThanOrEqual(1);
    });
  }
});

test("dashboard shows the stats, both records and the crest", async ({ page }) => {
  await open(page);
  await expect(page.locator("#stats .st")).toHaveCount(4);
  await expect(page.locator("#recWL")).toHaveText(/^\d+–\d+(–\d+)?$/);
  await expect(page.locator("#expRec")).toContainText("engine record");
  await expect(page.locator(".crest")).toBeVisible();
});

test("the record on the site matches the pick log", async ({ page }) => {
  await open(page, "#results");
  // recompute the verified Closer record from the log itself, the same rule the site promises
  const expected = await page.evaluate(() => {
    const g = rec.entries.filter((x) => ["W", "L", "P"].includes(x.status) && !x.prov && !x.loggedAfterStart && x.source !== "experimental");
    const w = g.filter((x) => x.status === "W").length, l = g.filter((x) => x.status === "L").length, p = g.filter((x) => x.status === "P").length;
    return `${w}–${l}${p ? `–${p}` : ""}`;
  });
  await expect(page.locator("#recWL")).toHaveText(expected);
  await expect(page.locator("#integ")).toContainText("Log verified", { timeout: 20_000 });
});

test("every pick card says who made it, and the badge explains itself", async ({ page }) => {
  await open(page, "#picks");
  const cards = page.locator("#pkList .pc:not(.inplay)");
  const n = await cards.count();
  test.skip(n === 0, "no open picks right now");
  for (let i = 0; i < n; i++) await expect(cards.nth(i).locator(".srcb")).toBeVisible();
  await cards.first().locator(".srcb").click();
  await expect(page.locator("#xsheet")).toHaveClass(/on/);
  await expect(page.locator("#xTitle")).toHaveText(/pick/i);
  await page.locator("#xClose").click();
  await expect(page.locator("#xsheet")).not.toHaveClass(/on/);
});

test("the 'how to read a pick' guide opens", async ({ page }) => {
  await open(page, "#picks");
  await page.locator(".guideb").click();
  await expect(page.locator("#xTitle")).toHaveText("How to read a pick");
  await expect(page.locator("#xBody")).toContainText("Better than our number");
});

test("adding a pick to the slip works and the payout adds up", async ({ page }) => {
  await open(page, "#picks");
  await page.evaluate(() => localStorage.removeItem("closer-slip"));
  const add = page.locator("#pkList button.addb").first();
  test.skip((await add.count()) === 0, "no pick can be added right now");
  await add.click();
  await expect(page.locator("#pkList button.addb.on").first()).toBeVisible();
  await page.goto("./#slip");
  await expect(page.locator("#slipBody .leg")).toHaveCount(1);
  // payout on a $10 stake must equal 10 x the decimal odds of the leg's American odds
  const { shown, odds } = await page.evaluate(() => ({ shown: document.getElementById("payout").textContent, odds: +document.querySelector("#slipBody .lo").textContent }));
  const dec = odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
  expect(shown).toBe("$" + (10 * dec).toFixed(2));
  await page.locator("#clr").click();
  await expect(page.locator("#slipBody")).toContainText("Your slip is empty");
});

test("old Classic links forward to the app", async ({ page }) => {
  await page.goto("./classic.html#record");
  await expect(page).toHaveURL(/#results$/);
});
