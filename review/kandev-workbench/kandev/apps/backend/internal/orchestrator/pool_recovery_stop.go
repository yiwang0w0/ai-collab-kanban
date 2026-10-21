package orchestrator

import (
	"context"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"go.uber.org/zap"
)

// WithPoolRecoveryStop 在原生屏障内提交意图，解锁后仅停止捕获的不可变执行。
func (s *Service) WithPoolRecoveryStop(ctx context.Context, identity runsmodels.PoolExecutionIdentity, admit func(context.Context) (bool, error)) error {
	if s == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	if err := s.authorizeTaskSessionPair(ctx, identity.TaskID, identity.SessionID); err != nil {
		return err
	}
	if admit == nil || !validPoolQuiescentIdentity(identity) || s.agentManager == nil || s.executor == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	committed, err := s.admitPoolRecoveryStop(ctx, identity, admit)
	if err != nil {
		return err
	}
	if committed {
		s.startOwnedLifecycleFollowup(func(owned context.Context) {
			if err := s.StopExecution(owned, identity.ExecutionID, "pool recovery: human stop", false); err != nil {
				s.logger.Warn("pool_recovery_stop_unconfirmed", zap.String("run_id", identity.RunID), zap.String("claim_id", identity.ClaimID), zap.Error(err))
			}
		})
	}
	return nil
}

func (s *Service) admitPoolRecoveryStop(ctx context.Context, identity runsmodels.PoolExecutionIdentity, admit func(context.Context) (bool, error)) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	unlock, err := s.acquirePoolQuiescenceFence(ctx, identity.SessionID)
	if err != nil {
		return false, err
	}
	defer unlock()
	var committed bool
	err = s.WithPoolEnqueueAdmission(ctx, identity.TaskID, func(guarded context.Context, preparing bool) error {
		if preparing {
			return runsmodels.ErrPoolTaskStartPreparing
		}
		currentID, err := s.agentManager.GetExecutionIDForSession(guarded, identity.SessionID)
		if err != nil {
			return runsmodels.ErrPoolResourcesUnconfirmed
		}
		if currentID != identity.ExecutionID {
			return runsmodels.ErrPoolRecoveryConflict
		}
		committed, err = admit(guarded)
		return err
	})
	return committed, err
}
