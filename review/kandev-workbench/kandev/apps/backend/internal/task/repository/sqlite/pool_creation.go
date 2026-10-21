package sqlite

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// CommitPoolTaskCreation 在原生创建收尾后原子提交批准和外部身份结算，不补造中断请求的批准。
func (r *Repository) CommitPoolTaskCreation(ctx context.Context, taskID string, version time.Time, externalID string) (bool, error) {
	intent, ok := models.PoolReleaseIntentFromContext(ctx)
	if !ok || !intent.Creating || intent.DeferCreation || intent.TaskID != taskID {
		return false, repoerrors.ErrPoolReleaseConfirmationRequired
	}
	if dialect.IsPostgres(r.db.DriverName()) {
		return false, repoerrors.ErrPoolStorageUnsupported
	}
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := r.lockTaskRepositoryReplacement(ctx, tx, taskID); err != nil {
		return false, err
	}
	matched, err := r.checkPoolCreationSnapshot(ctx, tx, intent, version, externalID)
	if err != nil || !matched {
		return false, err
	}
	now := time.Now().UTC()
	entryID, err := r.recordStepTransition(ctx, tx, stepTransitionInput{taskID: taskID,
		toWorkflowID: intent.WorkflowID, toWorkflowStepID: intent.StepID, occurredAt: now})
	if err != nil {
		return false, err
	}
	if err := r.settlePoolCreationTx(ctx, tx, taskID, externalID, now); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	r.dispatchStepEntry(ctx, taskID, intent.WorkflowID, intent.StepID, formatEntryID(entryID), 0)
	return true, nil
}

func (r *Repository) settlePoolCreationTx(ctx context.Context, tx *sqlx.Tx, taskID, externalID string, now time.Time) error {
	if externalID == "" {
		return nil
	}
	settlement, err := tx.ExecContext(ctx, r.db.Rebind(`UPDATE tasks SET external_id_settled_at = ?
		WHERE id = ? AND external_id = ? AND external_id_settled_at IS NULL`), now, taskID, externalID)
	if err != nil {
		return err
	}
	written, err := settlement.RowsAffected()
	if err != nil {
		return err
	}
	if written != 1 {
		return repoerrors.ErrTaskVersionConflict
	}
	return nil
}

func (r *Repository) checkPoolCreationSnapshot(ctx context.Context, tx *sqlx.Tx, intent models.PoolReleaseIntent,
	version time.Time, externalID string) (bool, error) {
	var workflowID, stepID, currentExternalID string
	var currentVersion time.Time
	var unsettled bool
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT workflow_id, workflow_step_id, updated_at,
		COALESCE(external_id, ''), external_id_settled_at IS NULL FROM tasks WHERE id = ?`), intent.TaskID).
		Scan(&workflowID, &stepID, &currentVersion, &currentExternalID, &unsettled)
	if err != nil {
		return false, err
	}
	if currentExternalID != externalID {
		return false, nil
	}
	if !version.Equal(currentVersion) || workflowID != intent.WorkflowID || stepID != intent.StepID || !unsettled {
		return false, repoerrors.ErrTaskVersionConflict
	}
	var entered bool
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT EXISTS (SELECT 1 FROM task_step_transitions WHERE task_id = ?)`), intent.TaskID).Scan(&entered); err != nil {
		return false, err
	}
	if entered {
		return false, repoerrors.ErrPoolReleaseConfirmationRequired
	}
	return true, nil
}
