import type { BusinessSelection, ReviewFieldSnapshot } from "../types/review";
import type { PageAdapter } from "./pageAdapter.ts";
import { pagePath, pageSelection, pathMatches } from "./selection.ts";

const ROUTE = "/vehicle-source";

/**
 * 车源审核页面的适配器。
 *
 * 只负责页面识别。13 个核对字段、图片分区和图片筛选依据由后端采集清单下发，
 * 不写在这里；可写控件尚未接入，页面动作注册表和写回仍待补充。
 */
export class VehicleSourcePageAdapter implements PageAdapter {
  public readonly id = "vehicle-source";

  public detect(url: string): BusinessSelection | null {
    if (pathMatches(pagePath(url), ROUTE)) {
      return pageSelection("vehicle_source", "default");
    }
    // 地址改版但页面内容未变时的兜底不在这里：页面特征文案由业务声明
    // （`RegionDeclaration.page_anchors`）下发，随页面识别清单一并生效。
    return null;
  }

  public listWritableFields(): readonly ReviewFieldSnapshot[] {
    return [];
  }
}
