import type { BusinessSelection, ReviewFieldSnapshot } from "../types/review";
import type { PageAdapter } from "./pageAdapter.ts";
import { pagePath, pageSelection, pathMatches } from "./selection.ts";

const ROUTE = "/vehicle-source";

/**
 * 车源审核页面的适配器。
 *
 * 当前只负责页面识别：车源业务尚未配置审核规则，可写控件和写回未接入。
 * 页面的字段、分区和图片筛选依据由后端采集清单下发，不需要写在这里。
 */
export class VehicleSourcePageAdapter implements PageAdapter {
  public readonly id = "vehicle-source";

  public detect(url: string, text = ""): BusinessSelection | null {
    if (pathMatches(pagePath(url), ROUTE)) {
      return pageSelection("vehicle_source", "default");
    }
    // 页面指纹兜底：URL 改版但页面内容未变时仍能识别。
    if (text.includes("车源审核") && text.includes("车辆来源信息")) {
      return pageSelection("vehicle_source", "default");
    }
    return null;
  }

  public listWritableFields(): readonly ReviewFieldSnapshot[] {
    return [];
  }
}
