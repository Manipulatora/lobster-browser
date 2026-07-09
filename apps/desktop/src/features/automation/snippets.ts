import type { LaunchInfo } from '../../api/tauri';

/** Automation connection snippets for a launched profile (UI-6). */
export interface Snippet {
  id: string;
  label: string;
  language: string;
  code: (info: LaunchInfo) => string;
}

export const SNIPPETS: Snippet[] = [
  {
    id: 'playwright-js',
    label: 'Playwright (JS)',
    language: 'javascript',
    code: (i) => `import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('${i.ws}');
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://example.com');`,
  },
  {
    id: 'puppeteer',
    label: 'Puppeteer',
    language: 'javascript',
    code: (i) => `import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserWSEndpoint: '${i.ws}',
});
const [page] = await browser.pages();
await page.goto('https://example.com');`,
  },
  {
    id: 'selenium-py',
    label: 'Selenium (Python)',
    language: 'python',
    code: (i) => `from selenium import webdriver

options = webdriver.ChromeOptions()
options.add_experimental_option("debuggerAddress", "${i.debuggerAddress}")
driver = webdriver.Chrome(options=options)
driver.get("https://example.com")`,
  },
  {
    id: 'playwright-py',
    label: 'Playwright (Python)',
    language: 'python',
    code: (i) => `from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("${i.ws}")
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://example.com")`,
  },
];
