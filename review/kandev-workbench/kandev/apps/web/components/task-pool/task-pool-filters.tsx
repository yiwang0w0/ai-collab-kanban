"use client";

import { useTranslation } from "react-i18next";
import { Input } from "@kandev/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@kandev/ui/select";
import { useAppStore } from "@/components/state-provider";
import { AppSidebarWorkspacePicker } from "@/components/app-sidebar/app-sidebar-workspace-picker";
import type { PoolCard } from "@/lib/types/task-pool";
import type { PoolFilters } from "@/lib/task-pool-view-model";
import { cn } from "@/lib/utils";

export function TaskPoolFilters({
  value,
  onChange,
  cards,
  className,
}: {
  value: PoolFilters;
  onChange: (value: PoolFilters) => void;
  cards: PoolCard[];
  className?: string;
}) {
  const { t } = useTranslation();
  const workflows = useAppStore((state) => state.workflows.items);
  const profiles = useAppStore((state) => state.agentProfiles.items);
  const workflowIds = [...new Set(cards.map((card) => card.workflow_id))];
  const profileIds = [
    ...new Set(
      cards
        .flatMap((card) => [
          card.pool_execution?.claimed_agent_profile_id,
          card.pool_execution?.planned_agent_profile_id,
        ])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  return (
    <div className={cn("grid min-w-0 gap-3", className)} data-testid="pool-filters">
      <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        {t("taskPool:workspace")}
        <AppSidebarWorkspacePicker triggerTestId="pool-workspace-picker" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("taskPool:search")}
        <Input
          value={value.query}
          onChange={(event) => onChange({ ...value, query: event.target.value })}
          data-testid="pool-search"
        />
      </label>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <span id="pool-workflow-label">{t("taskPool:workflow")}</span>
        <Select
          value={value.workflow}
          onValueChange={(workflow) => onChange({ ...value, workflow })}
        >
          <SelectTrigger aria-labelledby="pool-workflow-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("taskPool:allWorkflows")}</SelectItem>
            {workflowIds.map((id) => (
              <SelectItem key={id} value={id}>
                {workflows.find((flow) => flow.id === id)?.name ?? t("taskPool:workflow")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <span id="pool-agent-label">{t("taskPool:agent")}</span>
        <Select value={value.agent} onValueChange={(agent) => onChange({ ...value, agent })}>
          <SelectTrigger aria-labelledby="pool-agent-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("taskPool:allAgents")}</SelectItem>
            {profileIds.map((id) => (
              <SelectItem key={id} value={id}>
                {profiles.find((profile) => profile.id === id)?.label ?? t("taskPool:agentUnknown")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
