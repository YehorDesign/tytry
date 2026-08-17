// Скриншот ползунка «Слів на екрані»: node scripts/shot-words-slider.mjs [port]
import { pathToFileURL } from "node:url";
const pw = (
  await import(
    pathToFileURL(
      "C:/Users/Пользователь/AppData/Roaming/npm/node_modules/playwright-core/index.js"
    ).href
  )
).default;
const port = process.argv[2] || "3111";
const browser = await pw.chromium.launch({
  executablePath:
    "C:/Users/Пользователь/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
// выбрать первый проект в ленте
const card = page.locator(".project-card").first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(3000);
}
// карточки правой панели могут быть свёрнуты — раскрываем «Субтитри»
const capCard = page.locator(".panel-card", { hasText: /Субтитри|Captions/ }).first();
if ((await capCard.count()) && !(await capCard.getAttribute("class")).includes("open")) {
  await capCard.locator(".panel-card-head").click();
}
await page.waitForTimeout(1200);
const row = page.locator(".control-row", { hasText: /Слів|Words/ }).first();
await row.waitFor({ timeout: 15000 });
const slider = row.locator("input[type=range]");
console.log("min/max:", await slider.getAttribute("min"), await slider.getAttribute("max"));
console.log("value now:", await slider.inputValue(), "label:", await row.locator(".control-value").innerText());
// тянем в максимум → должно стать ∞
await slider.fill("20");
await slider.dispatchEvent("change");
await page.waitForTimeout(1500);
console.log("after max:", await row.locator(".control-value").innerText());
await row.screenshot({ path: "workspace/test-words-inf/slider.png" });
await page.locator(".panel, .side-panel, body").first().screenshot({ path: "workspace/test-words-inf/panel.png" });
await browser.close();
