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

  public detect(url: string, text = ""): BusinessSelection | null {
    if (pathMatches(pagePath(url), ROUTE)) {
      return pageSelection("vehicle_source", "default");
    }
    // 页面指纹兜底：URL 改版但页面内容未变时仍能识别。
    // 文案取自审核页自身的标题与区块名，不要用某个字段名，字段会改版。
    if (text.includes("车源审核") && text.includes("行驶证信息")) {
      return pageSelection("vehicle_source", "default");
    }
    return null;
  }

  public listWritableFields(): readonly ReviewFieldSnapshot[] {
    return [];
  }
}
