import type { PageActionRequest, PageActionResult, PageActionTransport } from "../types/pageActions";

/** 页面写回控制器只负责动作生命周期，不改变后端审核结论或人工处理状态。 */
export class PageActionController {
  private active = false;
  private readonly transport: PageActionTransport;

  public constructor(transport: PageActionTransport) {
    this.transport = transport;
  }

  public async fillAndLocate(request: PageActionRequest): Promise<PageActionResult> {
    if (this.active) {
      return { status: "FAILED", field: request.field, message: "已有页面操作正在执行" };
    }
    this.active = true;
    try {
      const result = await this.transport.fill(request);
      if (result.status !== "SUCCEEDED") return result;
      const focused = await this.transport.focus(request.field);
      return {
        ...result,
        focused: focused.status === "SUCCEEDED",
        highlighted: focused.status === "SUCCEEDED",
      };
    } catch (error) {
      return {
        status: "FAILED",
        field: request.field,
        message: error instanceof Error ? error.message : "页面写回失败",
      };
    } finally {
      this.active = false;
    }
  }
}
