package sqlite

import (
	"context"
	"database/sql"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

func (r *Repository) ReadPoolProjectionSnapshot(ctx context.Context, workspaceID string, query poolview.Query) (*poolview.Snapshot, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, repoerrors.ErrPoolStorageUnsupported
	}
	if workspaceID == "" || query.Limit < 1 || query.Limit > poolhistory.MaxItems || len(query.After) > 256 {
		return nil, poolview.ErrInvalidQuery
	}
	tx, err := r.ro.BeginTxx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var found string
	if err := tx.GetContext(ctx, &found, tx.Rebind(`SELECT id FROM workspaces WHERE id=?`), workspaceID); err != nil {
		if err == sql.ErrNoRows {
			return nil, repoerrors.ErrWorkspaceNotFound
		}
		return nil, err
	}
	snapshot := &poolview.Snapshot{WorkspaceID: found}
	err = tx.SelectContext(ctx, &snapshot.Cards, tx.Rebind(poolProjectionCardSQL+`
		WHERE t.workspace_id=? AND t.archived_at IS NULL AND t.is_ephemeral=0 AND t.id>?
		ORDER BY t.id LIMIT ?`), workspaceID, query.After, query.Limit+1)
	if err != nil {
		return nil, err
	}
	if len(snapshot.Cards) > query.Limit {
		snapshot.HasMore = true
		snapshot.Cards = snapshot.Cards[:query.Limit]
	}
	if err := r.loadPoolProjectionFacts(ctx, tx, snapshot); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return snapshot, nil
}

const poolProjectionCardSQL = `SELECT t.id AS task_id,t.workspace_id,substr(t.title,1,256) AS title,
	COALESCE(w.id,'') AS workflow_id,COALESCE(s.id,'') AS workflow_step_id,
	COALESCE(substr(s.name,1,128),'') AS stage,t.state AS task_state
	FROM tasks t LEFT JOIN workflows w ON w.id=t.workflow_id AND w.workspace_id=t.workspace_id
	LEFT JOIN workflow_steps s ON s.id=t.workflow_step_id AND s.workflow_id=w.id`
