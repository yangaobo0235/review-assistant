import type { PageData, PageActionIntent } from "../types/review";

export type PageActionExecutor = (intent: PageActionIntent, page: PageData) => Promise<string>;

/** Frontend action catalog; execution remains guarded by the active PageAdapter. */
export class PageActionRegistry {
  private readonly executors = new Map<string, PageActionExecutor>();

  public register(actionId: string, executor: PageActionExecutor): void {
    if (this.executors.has(actionId)) throw new Error(`页面动作已注册：${actionId}`);
    this.executors.set(actionId, executor);
  }

  public async executeAll(actions: readonly PageActionIntent[], page: PageData): Promise<string[]> {
    const messages: string[] = [];
    for (const action of actions) {
      const executor = this.executors.get(action.action_id);
      if (!executor) continue;
      messages.push(await executor(action, page));
    }
    return messages;
  }
}

