import type { BusinessSelection, ReviewFieldSnapshot } from "../types/review";
import type { PageAdapter } from "./pageAdapter.ts";
import { pagePath, pageSelection, pathMatches } from "./selection.ts";

const ROUTES: readonly [string, "qingdao" | "changchun"][] = [
  ["/consistency-qingdao", "qingdao"],
  ["/consistency-changchun", "changchun"],
];

/**
 * 一致性审核页面的适配器。
 *
 * 当前只负责页面识别：一致性业务尚未配置审核规则，可写控件和写回未接入。
 */
export class ConsistencyPageAdapter implements PageAdapter {
  public readonly id = "consistency";

  public detect(url: string): BusinessSelection | null {
    const path = pagePath(url);
    for (const [route, region] of ROUTES) {
      if (pathMatches(path, route)) return pageSelection("consistency", region);
    }
    return null;
  }

  public listWritableFields(): readonly ReviewFieldSnapshot[] {
    return [];
  }
}
