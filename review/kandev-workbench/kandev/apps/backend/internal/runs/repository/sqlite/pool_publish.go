package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

var ErrPoolDispatchAmbiguous = errors.New("pool_dispatch_identity_ambiguous")

// LockPoolTaskTx 只预留 SQLite 写权，不更改任务版本或伪造任务事件。
func (r *Repository) LockPoolTaskTx(ctx context.Context, tx *sqlx.Tx, taskID string) error {
	if dialect.IsPostgres(r.db.DriverName()) {
		return errors.New("pool_dispatch_unsupported_storage")
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE tasks SET id = id WHERE id = ?`), taskID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}

// FindPoolRunByKeyTx 使用持久唯一键，不以通用通知的时间窗限制去重。
func (r *Repository) FindPoolRunByKeyTx(ctx context.Context, tx *sqlx.Tx, key string) (*models.Run, error) {
	var runs []*models.Run
	if err := tx.SelectContext(ctx, &runs, tx.Rebind(`SELECT * FROM runs WHERE idempotency_key = ? LIMIT 2`), key); err != nil {
		return nil, err
	}
	if len(runs) > 1 {
		return nil, ErrPoolDispatchAmbiguous
	}
	if len(runs) == 0 {
		return nil, nil
	}
	return runs[0], nil
}

// FindActivePoolRunForTaskTx 不按 Profile 分桶；同一主卡不能同时拥有两份池执行权。
func (r *Repository) FindActivePoolRunForTaskTx(ctx context.Context, tx *sqlx.Tx, taskID string) (string, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return "", errors.New("pool_dispatch_unsupported_storage")
	}
	var runID string
	err := tx.QueryRowContext(ctx, tx.Rebind(`SELECT id FROM runs WHERE status IN ('queued', 'claimed')
		AND idempotency_key LIKE ? AND json_extract(payload, '$.task_id') = ?
		ORDER BY requested_at, id LIMIT 1`), models.PoolDispatchKeyPrefix+"%", taskID).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return runID, err
}
