package service

import (
	"context"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// CheckPoolTaskStart 只核验普通启动，不为调用者签发池领取许可。
func (s *Service) CheckPoolTaskStart(ctx context.Context, taskID string) error {
	if s.poolEnqueueAdmission == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return models.ErrPoolAdmissionUnavailable
	}
	return s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, taskID, func(admitted context.Context, _ bool) error {
		tx, err := s.repo.BeginEnqueueTx(admitted, "")
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if err := s.repo.LockPoolTaskTx(admitted, tx, taskID); err != nil {
			return err
		}
		runID, err := s.repo.FindActivePoolRunForTaskTx(admitted, tx, taskID)
		if err != nil {
			return err
		}
		if runID != "" {
			return &models.PoolTaskBusyError{RunID: runID}
		}
		return nil
	})
}
