import type { BusinessSelection, PageData, ReviewFieldSnapshot } from "../types/review";
import type { PageAdapter, PageLocator } from "./pageAdapter";

/** 报废置换适配器只描述页面边界；识别和 DOM 细节由 content script 注入。 */
export class ScrapReplacementPageAdapter implements PageAdapter {
  public readonly id = "scrap-replacement";
  private readonly collector: () => Promise<PageData>;
  private readonly fields: () => readonly ReviewFieldSnapshot[];
  private readonly locator?: PageLocator;

  public constructor(
    collector: () => Promise<PageData>,
    fields: () => readonly ReviewFieldSnapshot[],
    locator?: PageLocator,
  ) {
    this.collector = collector;
    this.fields = fields;
    this.locator = locator;
  }

  public detect(url: string): BusinessSelection | null {
    if (url.includes("scrap-replace-qingdao")) return this.selection("qingdao");
    if (url.includes("scrap-replace-changchun")) return this.selection("changchun");
    return null;
  }

  public collect(): Promise<PageData> {
    return this.collector();
  }

  public listWritableFields(): readonly ReviewFieldSnapshot[] {
    return this.fields();
  }

  public locate(field: string): Promise<{ found: boolean; highlighted: boolean }> {
    return this.locator?.locate(field) ?? Promise.resolve({ found: false, highlighted: false });
  }

  private selection(region: "qingdao" | "changchun"): BusinessSelection {
    return {
      businessType: "scrap_replacement",
      region,
      profileVersion: "1.0",
      workflowStage: "scrap_replacement",
      selectionMode: "AUTO",
    };
  }
}
