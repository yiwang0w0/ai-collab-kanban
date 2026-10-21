package service

import (
	"context"
	"strings"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/runs/models"
)

type poolRunHandler = func(context.Context, *models.ClaimedRun) error

// SetPoolRunProcessor 在共享消费者启动前注入 tasks 所有的池适配器。
// 普通工作流仍使用既有 Office 处理路径；此接缝不新增消费者。
func (s *Service) SetPoolRunProcessor(processor func(context.Context, *models.ClaimedRun) error) {
	s.poolRunProcessor = processor
}

func (si *SchedulerIntegration) processClaimedRun(ctx context.Context, claim *models.ClaimedRun) {
	if claim.IdempotencyKey == nil || !strings.HasPrefix(*claim.IdempotencyKey, models.PoolDispatchKeyPrefix) {
		si.processRun(ctx, claim.Run)
		return
	}
	reason := ""
	switch {
	case claim.ClaimID == "":
		reason = "claim_identity_missing"
	case si.svc.poolRunProcessor == nil:
		reason = "processor_unconfigured"
	default:
		if err := si.svc.poolRunProcessor(ctx, claim); err != nil {
			reason = "processor_failed"
		}
	}
	if reason != "" {
		// 回执或启动结果未知时保留领取，不进入通用失败重试或其他 Agent 回退。
		si.logger.Warn("pool_run_requires_verification", zap.String("run_id", claim.ID), zap.String("reason", reason))
	}
}
