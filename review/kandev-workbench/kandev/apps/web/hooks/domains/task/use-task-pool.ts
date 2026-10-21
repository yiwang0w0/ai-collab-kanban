"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/components/state-provider";
import { fetchTaskPool, fetchTaskPoolHistory } from "@/lib/api/domains/task-pool-api";

type ReadState<T> = {
  scope: string;
  data: T | null;
  confirmedAt: number | null;
  error: unknown;
  loading: boolean;
};

export function usePoolRead<T>(
  scope: string,
  load: (signal: AbortSignal) => Promise<T>,
  invalidation?: unknown,
) {
  const loader = useRef(load);
  const currentScope = useRef(scope);
  loader.current = load;
  currentScope.current = scope;
  const request = useRef({ sequence: 0, controller: null as AbortController | null });
  const retryAfter = useRef({ scope: "", until: 0 });
  const [state, setState] = useState<ReadState<T>>({
    scope,
    data: null,
    confirmedAt: null,
    error: null,
    loading: true,
  });
  const refresh = useCallback(async () => {
    if (!scope || currentScope.current !== scope || document.visibilityState !== "visible") return;
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++request.current.sequence;
    request.current.controller = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      request.current.sequence === sequence &&
      currentScope.current === scope;
    setState((previous) =>
      previous.scope === scope
        ? { ...previous, loading: true }
        : { scope, data: null, confirmedAt: null, error: null, loading: true },
    );
    try {
      const data = await loader.current(controller.signal);
      if (isCurrent()) {
        retryAfter.current = { scope, until: 0 };
        setState({ scope, data, confirmedAt: Date.now(), error: null, loading: false });
      }
    } catch (error) {
      if (isCurrent()) {
        retryAfter.current = { scope, until: Date.now() + 30_000 };
        setState((previous) => ({ ...previous, error, loading: false }));
      }
    }
  }, [scope]);
  useEffect(() => {
    if (retryAfter.current.scope !== scope || Date.now() >= retryAfter.current.until)
      void refresh();
    return () => {
      request.current.controller?.abort();
      request.current.sequence++;
    };
  }, [refresh, scope, invalidation]);
  useEffect(() => {
    const refreshVisible = () => {
      if (
        document.visibilityState === "visible" &&
        (retryAfter.current.scope !== scope || Date.now() >= retryAfter.current.until)
      )
        void refresh();
    };
    const interval = setInterval(refreshVisible, 10_000);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh, scope]);
  const visible =
    state.scope === scope
      ? state
      : { scope, data: null, confirmedAt: null, error: null, loading: true };
  return { ...visible, refresh };
}

export function useTaskPool(workspaceId: string | null, cursor: string) {
  const generation = useAppStore((state) => state.workspaceContextGeneration);
  const invalidation = useAppStore((state) =>
    workspaceId ? state.sidebarStatusSummaryByWorkspaceId?.[workspaceId] : undefined,
  );
  return usePoolRead(
    workspaceId ? `${workspaceId}:${generation}:${cursor}` : "",
    async (signal) => {
      const page = await fetchTaskPool(workspaceId!, cursor, { init: { signal } });
      if (page.workspace_id !== workspaceId || page.items.length > 50)
        throw new Error("pool_projection_unavailable");
      return page;
    },
    invalidation,
  );
}

export function useTaskPoolHistory(taskId: string, cursor: string) {
  return usePoolRead(`${taskId}:${cursor}`, async (signal) => {
    const page = await fetchTaskPoolHistory(taskId, cursor, { init: { signal } });
    if (page.task_id !== taskId || page.items.length > 50)
      throw new Error("pool_history_unavailable");
    return page;
  });
}
