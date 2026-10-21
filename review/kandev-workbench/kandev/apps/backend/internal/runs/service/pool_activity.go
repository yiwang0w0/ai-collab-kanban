package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// ObservePoolActivity 不触发模型、入队或恢复；没有当前池分配的普通事件保持无副作用。
func (s *Service) ObservePoolActivity(ctx context.Context, activity models.PoolExecutionActivity) (*models.RunEvent, error) {
	return s.observePoolSignal(ctx, activity, func(ctx context.Context, tx *sqlx.Tx) (*models.RunEvent, error) {
		return s.repo.AppendPoolActivityTx(ctx, tx, activity)
	})
}

func (s *Service) observePoolSignal(ctx context.Context, activity models.PoolExecutionActivity,
	appendSignal func(context.Context, *sqlx.Tx) (*models.RunEvent, error),
) (*models.RunEvent, error) {
	if s.poolEnqueueAdmission == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	found, err := s.repo.HasPoolActivityCandidate(ctx, activity)
	if err != nil || !found {
		return nil, err
	}
	var event *models.RunEvent
	err = s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, activity.TaskID, func(admitted context.Context, _ bool) error {
		tx, err := s.repo.BeginEnqueueTx(admitted, "")
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if err := s.repo.LockPoolTaskTx(admitted, tx, activity.TaskID); err != nil {
			return err
		}
		event, err = appendSignal(admitted, tx)
		if err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		return nil, err
	}
	s.notifyPoolProjection(activity.TaskID, event)
	return event, err
}
