package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

type poolExecutionQuiescenceAdmission interface {
	WithPoolExecutionQuiescence(context.Context, models.PoolExecutionIdentity, func(context.Context) error) error
}

type poolExecutionQuiescenceSource interface {
	CheckPoolExecutionQuiescentTx(context.Context, *sqlx.Tx, models.PoolExecutionIdentity) error
}

// FinalizeStoppedPoolRun 不调用提供商或清除资源，只在原生屏障内核验并结束当前领取。
func (s *Service) FinalizeStoppedPoolRun(ctx context.Context, identity models.PoolExecutionIdentity) (*models.RunEvent, error) {
	admission, admitted := s.poolEnqueueAdmission.(poolExecutionQuiescenceAdmission)
	source, supported := s.poolReleaseSource.(poolExecutionQuiescenceSource)
	if !admitted || !supported || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	var event *models.RunEvent
	err := admission.WithPoolExecutionQuiescence(ctx, identity, func(guarded context.Context) error {
		tx, err := s.repo.BeginEnqueueTx(guarded, "")
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if err := s.repo.LockPoolTaskTx(guarded, tx, identity.TaskID); err != nil {
			return err
		}
		if err := source.CheckPoolExecutionQuiescentTx(guarded, tx, identity); err != nil {
			return err
		}
		event, err = s.repo.FinalizeStoppedPoolRunTx(guarded, tx, identity)
		if err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		return nil, err
	}
	s.notifyPoolProjection(identity.TaskID, event)
	return event, nil
}
