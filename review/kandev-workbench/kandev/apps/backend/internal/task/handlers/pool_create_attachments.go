package handlers

import (
	"context"
	"time"

	v1 "github.com/kandev/kandev/pkg/api/v1"
	"go.uber.org/zap"
)

func (h *TaskHandlers) claimPoolCreateAttachments(ctx context.Context, taskID string, attachments []v1.MessageAttachment) error {
	err := h.service.ClaimMessageAttachments(ctx, taskID, "", attachments)
	if err == nil {
		return nil
	}
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if deleteErr := h.service.DeleteTaskWithLifecycle(rollbackCtx, taskID); deleteErr != nil {
		h.logger.Warn("附件绑定失败后的池卡清理失败", zap.String("task_id", taskID), zap.Error(deleteErr))
	}
	return err
}
