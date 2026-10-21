package sqlite

import (
	"context"
	"time"

	"github.com/kandev/kandev/internal/db/dialect"
)

// migratePoolHistorySchema 由既有 schema 所有者原子安装，不在迁移时猜测已丢失的历史。
func (r *Repository) migratePoolHistorySchema() error {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil
	}
	tx, err := r.db.BeginTxx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS run_pool_history_clearances (
			dispatch_key TEXT PRIMARY KEY,
			run_id TEXT NOT NULL UNIQUE,
			format_version INTEGER NOT NULL CHECK(format_version=1),
			workspace_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			entry_id INTEGER NOT NULL,
			release_json TEXT NOT NULL,
			requested_at TIMESTAMP NOT NULL,
			cleared_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS run_pool_history_policy (
			version INTEGER PRIMARY KEY CHECK(version=1),
			activated_at TIMESTAMP NOT NULL
		)`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(tx.Rebind(`INSERT INTO run_pool_history_policy(version,activated_at)
		VALUES(1,?) ON CONFLICT(version) DO NOTHING`), time.Now().UTC()); err != nil {
		return err
	}
	return tx.Commit()
}
