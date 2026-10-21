"use client";

import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import type { TaskPoolPageState } from "@/hooks/domains/task/use-task-pool-page";
import { cn } from "@/lib/utils";
import { poolPageChildren } from "@/lib/task-pool-view-model";
import { TaskPoolCard } from "./task-pool-card";
import { TaskPoolDetail } from "./task-pool-detail";

export function TaskPoolBrowser({ view }: { view: TaskPoolPageState }) {
  const { t } = useTranslation();
  if (!view.workspaceId) return <p className="p-4">{t("taskPool:chooseWorkspace")}</p>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {(view.desktop || !view.selectedId) && <PoolCardList view={view} />}
      {(view.desktop || view.selectedId) && (
        <section
          className={cn("flex min-h-0 min-w-0 flex-1", view.desktop && "border-l")}
          data-testid="pool-detail-surface"
        >
          {view.selected ? (
            <TaskPoolDetail
              key={view.selected.task_id}
              card={view.selected}
              children={poolPageChildren(view.cards, view.selected.task_id)}
              workspaceId={view.workspaceId}
              fresh={view.freshness === "fresh"}
              onRefresh={() => {
                void view.read.refresh();
              }}
              onBack={view.desktop ? undefined : () => view.select("")}
            />
          ) : (
            <div className="space-y-3 p-4 text-sm text-muted-foreground">
              <p>{t(view.selectedId ? "taskPool:missingSelection" : "taskPool:selectTask")}</p>
              {view.selectedId && (
                <Button variant="outline" onClick={() => view.select("")}>
                  {t("taskPool:back")}
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function PoolCardList({ view }: { view: TaskPoolPageState }) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = view.position.current;
  }, [view.position]);
  return (
    <div
      ref={scroll}
      onScroll={(event) => {
        view.position.current = event.currentTarget.scrollTop;
      }}
      className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3"
      data-testid="pool-card-list"
    >
      {view.read.data && view.visible.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground" data-testid="pool-empty">
          {t(view.cards.length === 0 ? "taskPool:empty" : "taskPool:noMatches")}
        </p>
      )}
      {view.visible.map((card) => (
        <TaskPoolCard
          key={card.task_id}
          card={card}
          selected={card.task_id === view.selected?.task_id}
          onSelect={() => view.select(card.task_id)}
        />
      ))}
    </div>
  );
}
