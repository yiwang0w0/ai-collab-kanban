import { fetchJson, type ApiRequestOptions } from "@/lib/api/client";
import type { PoolPage, PoolHistoryPage } from "@/lib/types/task-pool";

function poolQuery(cursor: string) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function fetchTaskPool(
  workspaceId: string,
  cursor = "",
  options?: ApiRequestOptions,
): Promise<PoolPage> {
  return fetchJson<PoolPage>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/task-pool?${poolQuery(cursor)}`,
    {
      ...options,
      cache: "no-store",
    },
  );
}
export function fetchTaskPoolHistory(
  taskId: string,
  cursor = "",
  options?: ApiRequestOptions,
): Promise<PoolHistoryPage> {
  return fetchJson<PoolHistoryPage>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/pool-history?${poolQuery(cursor)}`,
    {
      ...options,
      cache: "no-store",
    },
  );
}
