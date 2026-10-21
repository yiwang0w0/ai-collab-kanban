package sqlite

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// LoadPoolRecoveryTaskHeaderTx 只供已核对原生任务权限的宿主协调动作使用。
func (r *Repository) LoadPoolRecoveryTaskHeaderTx(ctx context.Context, tx *sqlx.Tx, taskID string) (runsmodels.PoolRecoveryTaskHeader, error) {
	var row struct {
		TaskID      string    `db:"id"`
		WorkspaceID string    `db:"workspace_id"`
		UpdatedAt   time.Time `db:"updated_at"`
		Archived    bool      `db:"archived"`
		Ephemeral   bool      `db:"is_ephemeral"`
	}
	err := tx.GetContext(ctx, &row, tx.Rebind(`SELECT id,workspace_id,updated_at,
		archived_at IS NOT NULL AS archived,is_ephemeral FROM tasks WHERE id=?`), taskID)
	header := runsmodels.PoolRecoveryTaskHeader{TaskID: row.TaskID, WorkspaceID: row.WorkspaceID,
		Version: row.UpdatedAt.UTC().Format(time.RFC3339Nano), Archived: row.Archived, Ephemeral: row.Ephemeral}
	if err != nil {
		return header, err
	}
	claim, exists, err := readTaskManagementClaimInTx(ctx, tx, r.db.Rebind, taskID, false)
	if err != nil || !exists {
		return header, err
	}
	if claim.WorkspaceID != header.WorkspaceID || claim.ResourceVersion == "" || len(claim.ResourceVersion) > 256 {
		return header, runsmodels.ErrPoolRecoveryConflict
	}
	header.ManagementVersion = claim.ResourceVersion
	header.ManagementOwnerKind = claim.OwnerKind
	header.ManagementOwnerActorID = claim.OwnerActorID
	return header, nil
}
