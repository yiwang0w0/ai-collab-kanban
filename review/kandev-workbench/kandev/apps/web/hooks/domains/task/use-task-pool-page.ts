"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/components/state-provider";
import { useResponsiveBreakpoint } from "@/hooks/use-responsive-breakpoint";
import { useRouter, useSearchParams } from "@/lib/routing/client-router";
import {
  matchesPoolFilters,
  poolCategory,
  poolFreshness,
  type PoolCategory,
  type PoolFilters,
} from "@/lib/task-pool-view-model";
import type { PoolCard } from "@/lib/types/task-pool";
import { useTaskPool } from "./use-task-pool";

const NO_CARDS: PoolCard[] = [];

export function useTaskPoolPage() {
  const router = useRouter();
  const params = useSearchParams();
  const workspaceId = useAppStore((state) => state.workspaces.activeId);
  const connected = useAppStore((state) => state.connection.status === "connected");
  const workflowId = useAppStore((state) => state.workflows.activeId);
  const { usesDesktopWorkbench: desktop } = useResponsiveBreakpoint();
  const [filters, setFilters] = useState<PoolFilters>({ query: "", workflow: "all", agent: "all" });
  const [category, setCategory] = useState<PoolCategory>("attention");
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [pagination, setPagination] = useState({ workspaceId, cursors: [""] });
  const position = useRef(0);
  const cursors = pagination.workspaceId === workspaceId ? pagination.cursors : [""];
  const read = useTaskPool(workspaceId, cursors[cursors.length - 1]);
  const cards = read.data?.items ?? NO_CARDS;
  const filtered = cards.filter((card) => matchesPoolFilters(card, filters));
  const visible = filtered.filter((card) => poolCategory(card) === category);
  const selectedId = params.get("task") ?? "";
  const selected =
    cards.find((card) => card.task_id === selectedId) ??
    (desktop && !selectedId ? visible[0] : undefined);
  const freshness = poolFreshness(read.confirmedAt, now, connected, Boolean(read.error));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    position.current = 0;
  }, [workspaceId]);
  const select = (taskId: string) => {
    const next = new URLSearchParams(params);
    if (taskId) next.set("task", taskId);
    else next.delete("task");
    router.push(`/task-pool${next.size ? `?${next}` : ""}`);
  };
  const changePage = (next: boolean) => {
    position.current = 0;
    setPagination({
      workspaceId,
      cursors: next ? [...cursors, read.data!.next_cursor] : cursors.slice(0, -1),
    });
    if (selectedId) select("");
  };
  return {
    workspaceId,
    workflowId,
    desktop,
    filters,
    setFilters,
    category,
    setCategory,
    filterOpen,
    setFilterOpen,
    createOpen,
    setCreateOpen,
    cursors,
    read,
    cards,
    filtered,
    visible,
    selectedId,
    selected,
    freshness,
    select,
    changePage,
    position,
  };
}

export type TaskPoolPageState = ReturnType<typeof useTaskPoolPage>;
