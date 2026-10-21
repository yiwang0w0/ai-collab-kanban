"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@kandev/ui/drawer";
import { POOL_CATEGORIES, poolCategory } from "@/lib/task-pool-view-model";
import type { TaskPoolPageState } from "@/hooks/domains/task/use-task-pool-page";
import { TaskPoolFilters } from "./task-pool-filters";

export function TaskPoolToolbar({ view }: { view: TaskPoolPageState }) {
  const { t } = useTranslation();
  const detailOnly = !view.desktop && Boolean(view.selectedId);
  return (
    <div className="shrink-0 space-y-2 border-b p-3">
      {view.freshness !== "fresh" && (
        <p
          role={view.freshness === "loading" ? "status" : "alert"}
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid="pool-freshness"
        >
          {t(`taskPool:${view.freshness}`)}
        </p>
      )}
      {view.read.confirmedAt !== null && (
        <p className="text-xs text-muted-foreground">
          {t("taskPool:confirmedAt", {
            time: new Date(view.read.confirmedAt).toLocaleTimeString(),
          })}
        </p>
      )}
      {!detailOnly && (
        <>
          <div
            className="grid grid-cols-2 gap-2 lg:grid-cols-4"
            role="group"
            aria-label={t("taskPool:title")}
          >
            {POOL_CATEGORIES.map((category) => (
              <Button
                key={category}
                variant={view.category === category ? "default" : "outline"}
                aria-pressed={view.category === category}
                onClick={() => view.setCategory(category)}
                data-testid={`pool-category-${category}`}
              >
                <span className="truncate">{t(`taskPool:categories.${category}`)}</span>
                <span className="tabular-nums">
                  {view.filtered.filter((card) => poolCategory(card) === category).length}
                </span>
              </Button>
            ))}
          </div>
          {view.desktop ? (
            <TaskPoolFilters
              value={view.filters}
              onChange={view.setFilters}
              cards={view.cards}
              className="grid-cols-2 lg:grid-cols-4"
            />
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => view.setFilterOpen(true)}
              data-testid="pool-filter-open"
            >
              {t("taskPool:filters")}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{t("taskPool:pageScope")}</p>
        </>
      )}
    </div>
  );
}

export function TaskPoolFilterDrawer({ view }: { view: TaskPoolPageState }) {
  const { t } = useTranslation();
  if (view.desktop) return null;
  return (
    <Drawer open={view.filterOpen} onOpenChange={view.setFilterOpen}>
      <DrawerContent
        className="mx-3 mb-3 max-h-[80dvh] rounded-2xl border"
        data-testid="pool-filter-drawer"
      >
        <DrawerHeader>
          <DrawerTitle>{t("taskPool:filters")}</DrawerTitle>
          <DrawerDescription>{t("taskPool:pageScope")}</DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <TaskPoolFilters value={view.filters} onChange={view.setFilters} cards={view.cards} />
          <Button className="mt-4 w-full" onClick={() => view.setFilterOpen(false)}>
            {t("taskPool:back")}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function TaskPoolPagination({ view }: { view: TaskPoolPageState }) {
  const { t } = useTranslation();
  if (!view.desktop && view.selectedId) return null;
  return (
    <div className="flex shrink-0 gap-2 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <Button
        variant="outline"
        disabled={view.cursors.length === 1 || view.read.loading}
        onClick={() => view.changePage(false)}
      >
        {t("taskPool:previous")}
      </Button>
      <Button
        variant="outline"
        disabled={!view.read.data?.next_cursor || view.read.loading}
        onClick={() => view.changePage(true)}
      >
        {t("taskPool:next")}
      </Button>
    </div>
  );
}
