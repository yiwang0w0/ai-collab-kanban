package orchestrator

import (
	"context"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// WithTaskPreparation 保留启动 I/O 期间的准入引用，但不持有任务写锁。
func (s *Service) WithTaskPreparation(ctx context.Context, taskID string, prepare func(context.Context) error) error {
	if err := s.authorizeTask(ctx, taskID); err != nil {
		return err
	}
	if taskID == "" || prepare == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	release, err := s.beginPoolTaskStart(ctx, taskID, nil)
	if err != nil {
		return err
	}
	defer release()
	return prepare(ctx)
}
