"use client";

import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ActionConfirmPopover } from "@/components/confirmation/action-confirm-popover";
import { MobileActionConfirmation } from "@/components/confirmation/mobile-action-confirmation";
import type { useTaskPoolRelease } from "@/hooks/domains/task/use-task-pool-release";
import { PoolAgent } from "./task-pool-facts";

type Props = {
  title: string;
  release: ReturnType<typeof useTaskPoolRelease>;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
};

export function TaskPoolReleaseConfirmation({ title, release, open, onOpenChange, anchor }: Props) {
  const { t } = useTranslation();
  const proposal = release.proposal;
  const description = (
    <div className="space-y-2">
      <p className="break-words font-medium">
        {title} → {proposal?.stepName}
      </p>
      <p>
        {t("taskPool:plannedAgent")}: <PoolAgent profileId={proposal?.profileId} />
      </p>
      <p>{t("taskPool:release.quota")}</p>
    </div>
  );
  const actions = {
    title: t("taskPool:release.confirmTitle"),
    description,
    cancelLabel: t("common:cancel"),
    confirmLabel: t("taskPool:release.confirm"),
    testId: "pool-release-confirmation",
    confirmTestId: "pool-release-confirm",
    onCancel: release.cancel,
    onConfirm: release.confirm,
    confirmDisabled: !proposal || release.confirmationKey !== proposal.key,
  };
  return (
    <MobileActionConfirmation
      {...actions}
      open={open}
      targetKey={release.confirmationKey}
      variant="default"
      onOpenChange={onOpenChange}
      focusReturnRef={anchor}
      useMobileSurfaceForCoarsePointer
      fallback={
        <ActionConfirmPopover
          {...actions}
          open={open}
          anchorRef={anchor}
          onOpenChange={onOpenChange}
          confirmationBoundary
        />
      }
    />
  );
}
