package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// PoolClaimReadySource 仅容许当前领取自身的活动运行，其他原生占用仍阻塞。
type PoolClaimReadySource interface {
	CheckPoolClaimReadyTx(context.Context, *sqlx.Tx, models.PoolReleaseSnapshot, string) error
}

type PoolRetryReadySource interface {
	CheckPoolRetryReadyTx(context.Context, *sqlx.Tx, models.PoolReleaseSnapshot, string) error
}

// AdmitPoolClaimStart 只供宿主池启动路径使用；成功仅登记一次尝试，不证明开工。
func (s *Service) AdmitPoolClaimStart(ctx context.Context, request models.PoolClaimStart) error {
	if !request.Valid() {
		return models.ErrPoolClaimStartConflict
	}
	source, ok := s.poolReleaseSource.(PoolClaimReadySource)
	if !ok || s.poolEnqueueAdmission == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return models.ErrPoolAdmissionUnavailable
	}
	return s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, request.Release.TaskID, func(admitted context.Context, preparing bool) error {
		if preparing {
			return models.ErrPoolTaskStartPreparing
		}
		return s.admitPoolClaimStartTx(admitted, source, request)
	})
}

func (s *Service) admitPoolClaimStartTx(ctx context.Context, source PoolClaimReadySource, request models.PoolClaimStart) error {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, request.Release.TaskID); err != nil {
		return err
	}
	release, err := s.poolReleaseSource.LoadPoolReleaseTx(ctx, tx, request.Release.TaskID, request.Release.EntryID)
	if err != nil {
		return err
	}
	run, err := s.repo.GetRunByIDTx(ctx, tx, request.RunID)
	if err != nil {
		return err
	}
	if !release.MatchesRun(run) || !request.Release.MatchesRun(run) {
		return models.ErrPoolClaimStartConflict
	}
	// 先在同事务验证领取及重试因果；候选检查失败会回滚此准入，不产生外部 I/O。
	if _, err := s.repo.AppendPoolLaunchAdmissionTx(ctx, tx, request); err != nil {
		return err
	}
	if err := s.checkPoolClaimReadinessTx(ctx, tx, source, release, request); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Service) checkPoolClaimReadinessTx(ctx context.Context, tx *sqlx.Tx, source PoolClaimReadySource, release models.PoolReleaseSnapshot, request models.PoolClaimStart) error {
	retry, err := s.repo.PoolHasPriorClaimTx(ctx, tx, request.RunID, request.ClaimID)
	if err != nil {
		return err
	}
	if !retry {
		return source.CheckPoolClaimReadyTx(ctx, tx, release, request.RunID)
	}
	readiness, supported := source.(PoolRetryReadySource)
	if !supported {
		return models.ErrPoolAdmissionUnavailable
	}
	return readiness.CheckPoolRetryReadyTx(ctx, tx, release, request.RunID)
}
