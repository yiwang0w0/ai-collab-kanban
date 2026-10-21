package sqlite

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

// CheckPoolHistoryTx 和现存运行查询共享发布写事务，清理提交后不能重新使用旧批准。
func (r *Repository) CheckPoolHistoryTx(ctx context.Context, tx *sqlx.Tx, key string, releasedAt time.Time) error {
	var count int
	if err := tx.GetContext(ctx, &count, tx.Rebind(`SELECT COUNT(*) FROM run_pool_history_clearances WHERE dispatch_key=?`), key); err != nil {
		return err
	}
	if count != 0 {
		return models.ErrPoolHistoryCleaned
	}
	var activatedAt time.Time
	if err := tx.GetContext(ctx, &activatedAt, `SELECT activated_at FROM run_pool_history_policy WHERE version=1`); err != nil {
		return err
	}
	if !releasedAt.After(activatedAt) {
		return models.ErrPoolHistoryLegacy
	}
	return nil
}
