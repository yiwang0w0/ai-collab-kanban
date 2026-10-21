package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	workflowmodels "github.com/kandev/kandev/internal/workflow/models"
)

// LoadPoolRelease 只读取同一快照中的当前任务、明确确认账本及尚未变化的阶段配置。
func (r *Repository) LoadPoolRelease(ctx context.Context, taskID string, entryID int64) (runsmodels.PoolReleaseSnapshot, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return runsmodels.PoolReleaseSnapshot{}, repoerrors.ErrPoolStorageUnsupported
	}
	tx, err := r.ro.BeginTx(ctx, nil)
	if err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()
	release, err := r.loadPoolReleaseTx(ctx, tx, taskID, entryID)
	if err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	return release, nil
}

// LoadPoolReleaseTx 与共享队列使用同一写事务，批准读取和入队之间不能插入阶段变化。
func (r *Repository) LoadPoolReleaseTx(ctx context.Context, tx *sqlx.Tx, taskID string, entryID int64) (runsmodels.PoolReleaseSnapshot, error) {
	return r.loadPoolReleaseTx(ctx, tx, taskID, entryID)
}

func (r *Repository) loadPoolReleaseTx(ctx context.Context, tx stepTransitionTx, taskID string, entryID int64) (runsmodels.PoolReleaseSnapshot, error) {
	var release runsmodels.PoolReleaseSnapshot
	if dialect.IsPostgres(r.db.DriverName()) {
		return release, repoerrors.ErrPoolStorageUnsupported
	}
	if tx == nil || taskID == "" || entryID <= 0 {
		return release, repoerrors.ErrPoolReleaseConfirmationRequired
	}
	err := tx.QueryRowContext(ctx, r.db.Rebind(`
		SELECT t.id, t.workspace_id, t.workflow_id, t.workflow_step_id, l.id, l.actor_id, l.occurred_at
		FROM tasks t JOIN task_step_transitions l ON l.task_id = t.id
		WHERE t.id = ? AND l.id = ? AND l.trigger = ? AND l.actor_kind = 'human'
		  AND l.actor_id IS NOT NULL AND l.actor_id <> '' AND l.contract_version = ?
		  AND l.to_workflow_id = t.workflow_id AND l.to_workflow_step_id = t.workflow_step_id
		  AND l.id = (SELECT MAX(id) FROM task_step_transitions WHERE task_id = t.id)
		  AND t.archived_at IS NULL AND t.is_ephemeral = 0 AND t.wip_admitted = 1
		  AND COALESCE(t.queued_for_step_id, '') = ''
	`), taskID, entryID, steptelemetry.TriggerPoolRelease, steptelemetry.ContractVersion).Scan(
		&release.TaskID, &release.WorkspaceID, &release.WorkflowID, &release.WorkflowStepID,
		&release.EntryID, &release.ActorID, &release.ReleasedAt)
	if err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	step, err := r.poolStepInTx(ctx, tx, release.WorkflowStepID)
	if err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	profile, pool, err := step.PoolExecutionProfile()
	if err != nil {
		return runsmodels.PoolReleaseSnapshot{}, err
	}
	if !pool || step.WorkflowID != release.WorkflowID || step.UpdatedAt.After(release.ReleasedAt) {
		return runsmodels.PoolReleaseSnapshot{}, workflowmodels.ErrInvalidPoolStep
	}
	release.AgentProfileID = profile
	return release, nil
}
