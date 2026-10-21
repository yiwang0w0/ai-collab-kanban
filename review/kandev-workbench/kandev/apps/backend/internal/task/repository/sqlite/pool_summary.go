package sqlite

import (
	"context"
	"database/sql"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// ReadPoolSummarySnapshot 只接受已授权任务列表的有界批次，包括仍可见的归档任务。
func (r *Repository) ReadPoolSummarySnapshot(ctx context.Context, workspaceID string, taskIDs []string) (*poolview.Snapshot, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, repoerrors.ErrPoolStorageUnsupported
	}
	if workspaceID == "" || len(taskIDs) == 0 || len(taskIDs) > poolhistory.MaxItems {
		return nil, poolview.ErrInvalidQuery
	}
	seen := make(map[string]bool, len(taskIDs))
	for _, id := range taskIDs {
		if id == "" || len(id) > 256 || seen[id] {
			return nil, poolview.ErrInvalidQuery
		}
		seen[id] = true
	}
	tx, err := r.ro.BeginTxx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	snapshot := &poolview.Snapshot{WorkspaceID: workspaceID}
	query, args, err := sqlx.In(poolProjectionCardSQL+` WHERE t.workspace_id=? AND t.id IN (?) ORDER BY t.id`, workspaceID, taskIDs)
	if err != nil {
		return nil, err
	}
	if err := tx.SelectContext(ctx, &snapshot.Cards, tx.Rebind(query), args...); err != nil {
		return nil, err
	}
	if err := r.loadPoolProjectionEvidence(ctx, tx, snapshot); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return snapshot, nil
}
