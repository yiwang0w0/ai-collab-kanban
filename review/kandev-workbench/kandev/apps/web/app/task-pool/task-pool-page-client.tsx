"use client";

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import { PageShell } from "@/components/page-shell";
import { TaskPoolBrowser } from "@/components/task-pool/task-pool-browser";
import {
  TaskPoolFilterDrawer,
  TaskPoolPagination,
  TaskPoolToolbar,
} from "@/components/task-pool/task-pool-toolbar";
import { useTaskPoolPage } from "@/hooks/domains/task/use-task-pool-page";

const TaskCreateDialog = lazy(() =>
  import("@/components/task-create-dialog").then((module) => ({
    default: module.TaskCreateDialog,
  })),
);

export function TaskPoolPageClient() {
  const { t } = useTranslation();
  const view = useTaskPoolPage();
  return (
    <PageShell
      title={t("taskPool:title")}
      scroll="none"
      topbarTestId="pool-topbar"
      actions={
        <Button
          disabled={!view.workspaceId}
          onClick={() => view.setCreateOpen(true)}
          data-testid="pool-new-task"
        >
          {t("taskPool:newTask")}
        </Button>
      }
      overflowActions={
        <Button
          variant="outline"
          onClick={() => void view.read.refresh()}
          data-testid="pool-refresh"
        >
          {t("taskPool:refresh")}
        </Button>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="task-pool-page">
        <TaskPoolToolbar view={view} />
        <TaskPoolBrowser view={view} />
        <TaskPoolPagination view={view} />
      </div>
      <TaskPoolFilterDrawer view={view} />
      {view.createOpen && (
        <Suspense fallback={null}>
          <TaskCreateDialog
            open
            onOpenChange={view.setCreateOpen}
            workspaceId={view.workspaceId}
            workflowId={view.workflowId}
            defaultStepId={null}
            steps={[]}
            onSuccess={() => void view.read.refresh()}
          />
        </Suspense>
      )}
    </PageShell>
  );
}
