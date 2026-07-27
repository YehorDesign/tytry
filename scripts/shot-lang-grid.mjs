// Скриншот плитки языков: открывает первый проект, разворачивает карточку
// «Ітерації», жмёт «Додати ітерацію» → «Переклад відео» и снимает панель.
// Ничего не сохраняет в проект: выбор языков живёт только в состоянии UI.
// playwright-core стоит глобально, а не в проекте
const { chromium } = await import(
  "file:///C:/Users/%D0%9F%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C/AppData/Roaming/npm/node_modules/playwright-core/index.mjs"
);

const EXE =
  "C:\\Users\\Пользователь\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1208\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3210/", { waitUntil: "domcontentloaded" });

await page.waitForSelector(".project-card", { timeout: 30000 });
await page.locator(".project-card").first().click();
await page.waitForTimeout(1500);

// карточка «Ітерації» может быть свёрнута — тыкаем заголовок, пока не раскроется
const head = page.getByRole("button", { name: /Ітерації|Iterations/ }).first();
const addBtn = page.getByRole("button", { name: /Додати ітерацію|Add iteration/ });
for (let i = 0; i < 3 && (await addBtn.count()) === 0; i++) {
  await head.click().catch(() => {});
  await page.waitForTimeout(500);
}

console.log(
  "buttons:",
  JSON.stringify((await page.locator("button").allTextContents()).filter(Boolean).slice(0, 60))
);
await page.screenshot({ path: "scripts/out-page.png" });
const add = page.getByRole("button", { name: /Додати ітерацію|Add iteration/ }).first();
await add.click({ timeout: 10000 });
await page.waitForTimeout(300);
const translate = page.getByRole("button", { name: /Переклад відео|Video translation/ }).first();
await translate.click({ timeout: 10000 });
await page.waitForTimeout(500);

// отмечаем три языка, чтобы увидеть и состояние, и счётчик на кнопке
for (const label of ["Deutsch", "Français", "עברית"]) {
  const chip = page.locator(".lang-chip", { hasText: label }).first();
  if (await chip.count()) await chip.click();
}
await page.waitForTimeout(300);

const panel = page.locator(".panel-card", { hasText: "Ітерації" }).first();
await (await panel.count() ? panel : page).screenshot({ path: "scripts/out-lang-grid.png" });
console.log("chips:", await page.locator(".lang-chip").count(), "on:", await page.locator(".lang-chip.on").count());
console.log("add button:", await page.getByRole("button", { name: /Додати .* переклад|Add .* translation/ }).first().textContent().catch(() => "—"));
await browser.close();
