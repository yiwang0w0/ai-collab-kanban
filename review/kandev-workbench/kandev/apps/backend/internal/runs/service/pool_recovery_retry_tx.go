package service

import (
	"context"

	"github.com/kandev/kandev/internal/runs/models"
)

func (s *Service) retryPoolRunTx(ctx context.Context, source poolRecoveryTaskSource, identity models.PoolExecutionIdentity, actor string, command models.PoolRecoveryCommand, quiescence poolExecutionQuiescenceSource, readiness PoolRetryReadySource) (*models.RunEvent, bool, error) {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, identity.TaskID); err != nil {
		return nil, false, err
	}
	snapshot, err := s.loadPoolRecoverySnapshotTx(ctx, tx, source, identity.TaskID, command.RunID)
	if err != nil {
		return nil, false, err
	}
	previous, err := s.recoveryRetryReplayTx(ctx, tx, snapshot, actor, command)
	if err != nil || previous != nil {
		return previous, false, err
	}
	if err := checkPoolRecoveryManager(snapshot.header, actor, command.ExpectedManagementVersion); err != nil {
		return nil, false, err
	}
	if err := s.validatePoolWithdrawalTx(ctx, tx, snapshot.header, snapshot.run, snapshot.release, command); err != nil {
		return nil, false, err
	}
	if err := quiescence.CheckPoolExecutionQuiescentTx(ctx, tx, identity); err != nil {
		return nil, false, err
	}
	if err := readiness.CheckPoolRetryReadyTx(ctx, tx, snapshot.release, snapshot.run.ID); err != nil {
		return nil, false, err
	}
	operation := recoveryRetryOperation(snapshot, actor, command, identity, 0)
	event, err := s.repo.RequeueStoppedPoolRunTx(ctx, tx, operation)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return event, true, nil
}
