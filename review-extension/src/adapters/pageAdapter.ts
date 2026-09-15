import type { BusinessSelection, PageData, ReviewFieldSnapshot } from "../types/review";

export interface PageAdapter {
  readonly id: string;
  detect(url: string, text?: string): BusinessSelection | null;
  collect(): Promise<PageData>;
  listWritableFields(): readonly ReviewFieldSnapshot[];
  writeField?(field: string, value: string, expectedValue?: string | null): Promise<{ ok: boolean; message?: string }>;
  rereadField?(field: string): Promise<string | null>;
  rollbackField?(field: string, value: string): Promise<{ ok: boolean; message?: string }>;
}

export interface PageLocator {
  locate(field: string): Promise<{ found: boolean; highlighted: boolean }>;
}

export interface PageIdentity {
  pageUrl: string;
  pageInstanceId: string;
  pageFingerprint: string;
  collectionId: string;
}

/**
 * Single browser adapter entrypoint.  Content scripts can register adapters
 * for new pages without adding business branches to the review panel.
 */
export class PageAdapterRegistry {
  private readonly adapters = new Map<string, PageAdapter>();

  public register(adapter: PageAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`页面适配器已注册：${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  public get(id: string): PageAdapter | undefined {
    return this.adapters.get(id);
  }

  public list(): readonly PageAdapter[] {
    return [...this.adapters.values()];
  }

  public resolve(url: string, text = ""): PageAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.detect(url, text)) return adapter;
    }
    return null;
  }

  public require(url: string, text = ""): PageAdapter {
    const adapter = this.resolve(url, text);
    if (!adapter) throw new Error("无法识别当前审核页面");
    return adapter;
  }

  public assertIdentity(expected: PageIdentity, actual: PageIdentity): void {
    if (
      expected.pageUrl !== actual.pageUrl
      || expected.pageInstanceId !== actual.pageInstanceId
      || expected.collectionId !== actual.collectionId
      || expected.pageFingerprint !== actual.pageFingerprint
    ) {
      throw new Error("页面已变化，请重新采集");
    }
  }
}
