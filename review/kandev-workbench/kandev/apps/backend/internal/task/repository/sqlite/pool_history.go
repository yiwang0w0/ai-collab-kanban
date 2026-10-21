package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// PoolHistoryWorkspace 只读取权限定位所需的字段，不水合任务正文或会话。
func (r *Repository) PoolHistoryWorkspace(ctx context.Context, taskID string) (string, error) {
	var workspaceID string
	err := r.ro.GetContext(ctx, &workspaceID, r.ro.Rebind(`SELECT workspace_id FROM tasks WHERE id=?`), taskID)
	if err == sql.ErrNoRows {
		return "", repoerrors.ErrTaskNotFound
	}
	return workspaceID, err
}

func (r *Repository) ReadPoolHistorySnapshot(ctx context.Context, taskID, workspaceID string, query poolhistory.Query) (*poolhistory.Snapshot, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, repoerrors.ErrPoolStorageUnsupported
	}
	if query.Limit < 1 || query.Limit > poolhistory.MaxItems || query.Before < 0 {
		return nil, poolhistory.ErrInvalidQuery
	}
	tx, err := r.ro.BeginTxx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var header struct {
		LatestEntryID int64     `db:"latest_entry_id"`
		WorkflowID    string    `db:"workflow_id"`
		StepID        string    `db:"step_id"`
		ActivatedAt   time.Time `db:"activated_at"`
	}
	if err := tx.GetContext(ctx, &header, tx.Rebind(`SELECT COALESCE((SELECT MAX(id) FROM task_step_transitions WHERE task_id=t.id),0) AS latest_entry_id,
		COALESCE(t.workflow_id,'') AS workflow_id,COALESCE(t.workflow_step_id,'') AS step_id,
		(SELECT activated_at FROM run_pool_history_policy WHERE version=1) AS activated_at
		FROM tasks t WHERE t.id=? AND t.workspace_id=?`), taskID, workspaceID); err != nil {
		if err == sql.ErrNoRows {
			return nil, repoerrors.ErrTaskNotFound
		}
		return nil, err
	}
	snapshot := &poolhistory.Snapshot{TaskID: taskID, WorkspaceID: workspaceID, LatestEntryID: header.LatestEntryID,
		CurrentWorkflowID: header.WorkflowID, CurrentStepID: header.StepID, PolicyActivatedAt: header.ActivatedAt}
	if err := r.loadPoolHistoryEntries(ctx, tx, snapshot, query); err != nil {
		return nil, err
	}
	if len(snapshot.Entries) != 0 {
		if err := r.loadPoolHistoryRuns(ctx, tx, snapshot); err != nil {
			return nil, err
		}
		if err := r.loadPoolHistorySelections(ctx, tx, snapshot, query); err != nil {
			return nil, err
		}
		if err := r.loadPoolHistoryEvents(ctx, tx, snapshot); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func (r *Repository) loadPoolHistoryEntries(ctx context.Context, tx *sqlx.Tx, snapshot *poolhistory.Snapshot, query poolhistory.Query) error {
	err := tx.SelectContext(ctx, &snapshot.Entries, tx.Rebind(`SELECT l.id,
		COALESCE(l.to_workflow_id,'') AS workflow_id, COALESCE(l.to_workflow_step_id,'') AS step_id,
		l.actor_kind, COALESCE(l.actor_id,'') AS actor_id, l.contract_version, l.occurred_at,
		CASE WHEN s.updated_at<=l.occurred_at AND length(COALESCE(s.agent_profile_id,''))<=256
			THEN COALESCE(s.agent_profile_id,'') ELSE '' END AS planned_profile
		FROM task_step_transitions l LEFT JOIN workflow_steps s ON s.id=l.to_workflow_step_id AND s.workflow_id=l.to_workflow_id
		WHERE l.task_id=? AND l.trigger=? AND (?=0 OR l.id<=?) ORDER BY l.id DESC LIMIT ?`),
		snapshot.TaskID, steptelemetry.TriggerPoolRelease, query.Before, query.Before, poolhistory.MaxItems+2)
	if err != nil {
		return err
	}
	return nil
}
