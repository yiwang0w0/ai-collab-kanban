package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

// ObservePoolTurnEnd 仅记原生回合证据，不结束领取、调度下一次执行或改主卡状态。
func (s *Service) ObservePoolTurnEnd(ctx context.Context, activity models.PoolExecutionActivity, failed bool) (*models.RunEvent, error) {
	return s.observePoolSignal(ctx, activity, func(ctx context.Context, tx *sqlx.Tx) (*models.RunEvent, error) {
		return s.repo.AppendPoolTurnEndTx(ctx, tx, activity, failed)
	})
}
