"use client";

import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ActionConfirmPopover } from "@/components/confirmation/action-confirm-popover";
import { MobileActionConfirmation } from "@/components/confirmation/mobile-action-confirmation";
import type { useTaskPoolRecovery } from "@/hooks/domains/task/use-task-pool-recovery";

type Props = {
  title: string;
  recovery: ReturnType<typeof useTaskPoolRecovery>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
};

export function TaskPoolRecoveryConfirmation({
  title,
  recovery,
  open,
  onOpenChange,
  anchor,
}: Props) {
  const { t } = useTranslation();
  const proposal = recovery.proposal;
  const action = proposal?.action ?? "withdraw";
  const description = (
    <div className="space-y-2">
      <p className="break-words font-medium">{title}</p>
      <p>{t(`taskPool:recovery.warning.${action}`)}</p>
    </div>
  );
  const props = {
    title: t(`taskPool:recovery.action.${action}`),
    description,
    cancelLabel: t("common:cancel"),
    confirmLabel: t("taskPool:recovery.confirm"),
    testId: "pool-recovery-confirmation",
    confirmTestId: "pool-recovery-confirm",
    onCancel: recovery.cancel,
    onConfirm: recovery.confirm,
    confirmDisabled: !proposal || recovery.confirmationKey !== JSON.stringify(proposal),
  };
  return (
    <MobileActionConfirmation
      {...props}
      open={open}
      targetKey={recovery.confirmationKey}
      onOpenChange={onOpenChange}
      focusReturnRef={anchor}
      useMobileSurfaceForCoarsePointer
      variant="destructive"
      fallback={
        <ActionConfirmPopover
          {...props}
          open={open}
          anchorRef={anchor}
          onOpenChange={onOpenChange}
          confirmationBoundary
        />
      }
    />
  );
}
