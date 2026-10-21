package orchestrator

import (
	"context"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/orchestrator/watcher"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type poolStoppedRunFinalizer interface {
	FinalizeStoppedPoolRun(context.Context, runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error)
}

func (s *Service) schedulePoolStoppedReconciliation(data watcher.AgentEventData, identity *runsmodels.PoolExecutionIdentity) bool {
	finalizer, supported := s.poolTaskStartGuard.(poolStoppedRunFinalizer)
	if !supported || identity == nil {
		return false
	}
	scope := *identity
	s.startOwnedLifecycleFollowup(func(ctx context.Context) {
		if err := s.reconcilePoolStoppedSession(ctx, data); err != nil {
			return
		}
		guarded := context.WithValue(ctx, poolQuiescenceWaitKey{}, true)
		if _, err := finalizer.FinalizeStoppedPoolRun(guarded, scope); err != nil {
			s.logger.Warn("pool_execution_finish_unconfirmed", zap.String("run_id", scope.RunID),
				zap.String("claim_id", scope.ClaimID), zap.Error(err))
		}
	})
	return true
}

func (s *Service) reconcilePoolStoppedSession(ctx context.Context, data watcher.AgentEventData) error {
	lock, release := s.acquireCancelInFlightGuard(data.SessionID)
	defer release()
	if err := lock.LockContext(ctx); err != nil {
		return err
	}
	defer lock.Unlock()
	s.handleAgentStoppedLocked(ctx, data)
	return ctx.Err()
}
