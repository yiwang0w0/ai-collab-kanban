package service

import (
	"context"
	"errors"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

func (s *Service) poolRecoveryReadRetry(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, result *models.PoolRecoveryContext) (models.PoolExecutionIdentity, error) {
	var identity models.PoolExecutionIdentity
	actor, human := poolRecoveryHuman(ctx)
	if !human || checkPoolRecoveryManager(snapshot.header, actor, result.ManagementVersion) != nil {
		return identity, nil
	}
	_, admitted := s.poolEnqueueAdmission.(poolExecutionQuiescenceAdmission)
	quiescence, supported := s.poolReleaseSource.(poolExecutionQuiescenceSource)
	readiness, ready := s.poolReleaseSource.(PoolRetryReadySource)
	if !admitted || !supported || !ready || result.ClaimID == "" {
		return identity, nil
	}
	identity, err := s.repo.PoolRecoveryExecutionTx(ctx, tx, snapshot.run, result.ClaimID)
	if err == nil {
		err = s.repo.CheckPoolRetryEvidenceTx(ctx, tx, identity)
	}
	if err == nil {
		err = quiescence.CheckPoolExecutionQuiescentTx(ctx, tx, identity)
	}
	command := models.PoolRecoveryCommand{ExpectedTaskVersion: result.TaskVersion, ExpectedRunVersion: result.RunVersion}
	if err == nil {
		err = s.validatePoolWithdrawalTx(ctx, tx, snapshot.header, snapshot.run, snapshot.release, command)
	}
	if err == nil {
		err = readiness.CheckPoolRetryReadyTx(ctx, tx, snapshot.release, snapshot.run.ID)
	}
	if err != nil {
		if poolRecoveryEvidenceConflict(err) || errors.Is(err, repoerrors.ErrPoolTaskNotAdmitted) || errors.Is(err, repoerrors.ErrPoolStepChanged) {
			result.Reason = "retry_not_verified"
			return models.PoolExecutionIdentity{}, nil
		}
		return models.PoolExecutionIdentity{}, err
	}
	result.Actions.Retry, result.Reason = true, ""
	return identity, nil
}

// 先结束只读事务，再进入原生生命周期及任务屏障，防止读事务与写入锁序倒置。
func (s *Service) probePoolRecoveryQuiescence(ctx context.Context, identity models.PoolExecutionIdentity, result *models.PoolRecoveryContext) {
	if !result.Actions.Retry {
		return
	}
	admission, supported := s.poolEnqueueAdmission.(poolExecutionQuiescenceAdmission)
	if !supported || admission.WithPoolExecutionQuiescence(ctx, identity, func(context.Context) error { return nil }) != nil {
		result.Actions.Retry, result.Reason = false, "resources_unconfirmed"
	}
}
