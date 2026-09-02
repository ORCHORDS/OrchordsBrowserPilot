import { chromium, type Browser, type Page, type BrowserContext } from "playwright";

export interface BrowserManager {
  page(): Promise<Page>;
  close(): Promise<void>;
}

class LocalBrowserManager implements BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;

  constructor(private readonly headless: boolean) {}

  async page(): Promise<Page> {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
    if (!this.context) {
      this.context = await this.browser.newContext();
    }
    this.currentPage = await this.context.newPage();
    return this.currentPage;
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.currentPage = null;
  }
}

class RemoteBrowserManager implements BrowserManager {
  constructor(private readonly wsEndpoint: string, private readonly headless: boolean) {}

  async page(): Promise<Page> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remote = await (chromium as any).connect(this.wsEndpoint, { headless: this.headless });
    const context = await remote.newContext();
    const page = await context.newPage();
    return page;
  }

  async close(): Promise<void> {
    // Remote browser lifecycle is owned by the provider.
  }
}

export function createBrowserManager(wsEndpoint: string | undefined, headless: boolean): BrowserManager {
  return wsEndpoint ? new RemoteBrowserManager(wsEndpoint, headless) : new LocalBrowserManager(headless);
}
