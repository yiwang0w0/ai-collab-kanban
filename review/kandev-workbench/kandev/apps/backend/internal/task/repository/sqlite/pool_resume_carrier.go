package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/agentruntime"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type poolStoppedInventory struct {
	ID          string `db:"id"`
	TaskID      string `db:"task_id"`
	SessionID   string `db:"session_id"`
	ExecutionID string `db:"agent_execution_id"`
	ProfileID   string `db:"profile_id"`
	ExecutorID  string `db:"executor_id"`
	Status      string `db:"status"`
	Runtime     string `db:"runtime"`
	LocalPID    int    `db:"local_pid"`
	RemotePID   int    `db:"pid"`
}

// 原生恢复载体不是单独的停止证明；调用者仍须核对同一执行的真实停止回执和当前宿主空闲。
func (r *Repository) checkPoolStoppedInventoryTx(ctx context.Context, tx *sqlx.Tx, identity runsmodels.PoolExecutionIdentity) error {
	rows := make([]poolStoppedInventory, 0, 2)
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(`SELECT id, COALESCE(task_id, '') AS task_id,
		COALESCE(session_id, '') AS session_id, COALESCE(agent_execution_id, '') AS agent_execution_id,
		COALESCE(execution_profile_id, '') AS profile_id, COALESCE(executor_id, '') AS executor_id,
		COALESCE(status, '') AS status, COALESCE(runtime, '') AS runtime,
		COALESCE(local_pid, 0) AS local_pid, COALESCE(pid, 0) AS pid
		FROM executors_running WHERE task_id = ? OR session_id = ? ORDER BY id LIMIT 2`), identity.TaskID, identity.SessionID); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	if len(rows) != 1 || !rows[0].matches(identity) || !rows[0].releasedCarrier() {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	return nil
}

func (row poolStoppedInventory) matches(identity runsmodels.PoolExecutionIdentity) bool {
	return row.ID == identity.SessionID && row.SessionID == identity.SessionID && row.TaskID == identity.TaskID &&
		row.ExecutionID == identity.ExecutionID && (row.ProfileID == "" || row.ProfileID == identity.ExecutionProfileID)
}

func (row poolStoppedInventory) releasedCarrier() bool {
	return row.ExecutorID == models.ExecutorIDWorktree && row.Status == models.ExecutorRunningStatusStopped &&
		row.LocalPID == 0 && row.RemotePID == 0 && (row.Runtime == "" || row.Runtime == string(agentruntime.RuntimeStandalone))
}
