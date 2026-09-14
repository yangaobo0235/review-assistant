export type ActionStatus = "IDLE" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STALE_PAGE";

export interface PageActionRequest {
  field: string;
  value: string;
  pageInstanceId: string;
  expectedCurrentValue?: string | null;
}

export interface PageActionResult {
  status: ActionStatus;
  field: string;
  value?: string;
  message?: string;
  focused?: boolean;
  highlighted?: boolean;
}

export interface PageActionTransport {
  fill(request: PageActionRequest): Promise<PageActionResult>;
  focus(field: string): Promise<PageActionResult>;
}
