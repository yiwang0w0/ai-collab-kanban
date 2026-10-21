package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

// ObservePoolExecutionStopped 只保存可信宿主停止事实；领取终结仍须独立核验资源与原生占用。
func (s *Service) ObservePoolExecutionStopped(ctx context.Context, activity models.PoolExecutionActivity, source, runtimeInstanceID string, released bool) (*models.RunEvent, error) {
	return s.observePoolSignal(ctx, activity, func(ctx context.Context, tx *sqlx.Tx) (*models.RunEvent, error) {
		return s.repo.AppendPoolExecutionStoppedTx(ctx, tx, activity, source, runtimeInstanceID, released)
	})
}
