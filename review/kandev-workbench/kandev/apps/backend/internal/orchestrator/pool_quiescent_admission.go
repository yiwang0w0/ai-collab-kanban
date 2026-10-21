package orchestrator

import (
	"context"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type poolRuntimeQuiescenceChecker interface {
	CheckExecutionQuiescent(context.Context, string, string, string) error
}

type poolQuiescenceWaitKey struct{}

// WithPoolExecutionQuiescence 复用原生生命周期屏障和任务准入，不等待可能由停止调用者持有的生命周期锁。
func (s *Service) WithPoolExecutionQuiescence(ctx context.Context, identity runsmodels.PoolExecutionIdentity, fn func(context.Context) error) error {
	if s == nil || fn == nil || !validPoolQuiescentIdentity(identity) {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	unlock, err := s.acquirePoolQuiescenceFence(ctx, identity.SessionID)
	if err != nil {
		return err
	}
	defer unlock()
	return s.WithPoolEnqueueAdmission(ctx, identity.TaskID, func(admitted context.Context, preparing bool) error {
		if preparing {
			return runsmodels.ErrPoolTaskStartPreparing
		}
		if err := s.checkPoolRuntimeQuiescence(admitted, identity); err != nil {
			return err
		}
		return fn(admitted)
	})
}

func (s *Service) acquirePoolQuiescenceFence(ctx context.Context, sessionID string) (func(), error) {
	if unlock, acquired := s.tryAcquireSessionLifecycleLock(sessionID); acquired {
		return unlock, nil
	}
	if wait, _ := ctx.Value(poolQuiescenceWaitKey{}).(bool); !wait {
		return nil, runsmodels.ErrPoolResourcesUnconfirmed
	}
	// 只有受关闭管理的后续工作可等待原生互斥锁；不重试证据错误、资源占用或提供商动作。
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			if unlock, acquired := s.tryAcquireSessionLifecycleLock(sessionID); acquired {
				return unlock, nil
			}
		}
	}
}

func validPoolQuiescentIdentity(i runsmodels.PoolExecutionIdentity) bool {
	return i.TaskID != "" && i.SessionID != "" && i.ExecutionID != "" && i.PromptGeneration == 1 &&
		i.AgentProfileID != "" && i.ExecutionProfileID == i.AgentProfileID
}

func (s *Service) checkPoolRuntimeQuiescence(ctx context.Context, identity runsmodels.PoolExecutionIdentity) error {
	if s.lspLeases != nil && s.lspLeases.HasActiveLSPLeaseForExecution(identity.ExecutionID) {
		return runsmodels.ErrPoolResourcesUnconfirmed
	}
	checker, supported := s.agentManager.(poolRuntimeQuiescenceChecker)
	if !supported {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	return checker.CheckExecutionQuiescent(ctx, identity.ExecutionID, identity.TaskID, identity.SessionID)
}
