// Closer site tests. By default they check the live site; set SITE_URL to test another copy
// (GitHub runs them against the files in each change before relying on the live deploy).
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: 1,            // one retry absorbs a slow network moment; a real break fails twice
  reporter: [["list"]],
  use: {
    baseURL: process.env.SITE_URL || "https://domrugg44.github.io/closer-live/",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
