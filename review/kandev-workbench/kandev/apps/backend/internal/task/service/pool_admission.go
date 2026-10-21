package service

import (
	"context"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// PoolReleaseAdmission 在原生任务锁内完成池批准，不覆盖提交后的普通任务动作。
type PoolReleaseAdmission interface {
	WithPoolReleaseAdmission(context.Context, string, func(context.Context) error) error
}

// SetPoolReleaseAdmission 只在构造期注入同一宿主的协调器。
func (s *Service) SetPoolReleaseAdmission(admission PoolReleaseAdmission) {
	s.poolReleaseAdmission = admission
}

func (s *Service) withPoolReleaseAdmission(ctx context.Context, taskID string, confirmation *PoolReleaseConfirmation, write func(context.Context) error) error {
	if confirmation == nil {
		return write(ctx)
	}
	if s.poolReleaseAdmission == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	return s.poolReleaseAdmission.WithPoolReleaseAdmission(ctx, taskID, write)
}
