package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// CheckPoolExecutionQuiescentTx 只核对原生数据库占用；调用者仍须证明本次执行已停止及宿主活动已释放。
func (r *Repository) CheckPoolExecutionQuiescentTx(ctx context.Context, tx *sqlx.Tx, i runsmodels.PoolExecutionIdentity) error {
	if dialect.IsPostgres(r.db.DriverName()) {
		return repoerrors.ErrPoolStorageUnsupported
	}
	if i.PromptGeneration != 1 || i.AgentProfileID == "" || i.ExecutionProfileID != i.AgentProfileID {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	var matched bool
	err := tx.GetContext(ctx, &matched, tx.Rebind(`SELECT EXISTS (SELECT 1 FROM task_sessions s
		JOIN task_session_turns t ON t.task_session_id = s.id JOIN tasks task ON task.id = s.task_id
		WHERE s.id = ? AND t.id = ? AND s.task_id = ? AND t.task_id = ? AND s.agent_profile_id = ?
		AND COALESCE(s.execution_profile_id, '') IN ('', ?) AND COALESCE(t.execution_profile_id, '') IN ('', ?)
		AND s.executor_id = ? AND t.completed_at IS NOT NULL
		AND s.state IN ('IDLE', 'WAITING_FOR_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'))`),
		i.SessionID, i.TurnID, i.TaskID, i.TaskID, i.AgentProfileID, i.ExecutionProfileID, i.ExecutionProfileID, models.ExecutorIDWorktree)
	if err != nil {
		return err
	}
	if !matched {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	if err := r.checkPoolStoppedInventoryTx(ctx, tx, i); err != nil {
		return err
	}
	if err := r.checkPoolTaskActivityTx(ctx, tx, i.TaskID, i.RunID, i.SessionID, i.TurnID); err != nil {
		return err
	}
	// checkout 字段由 Office 的原生 schema 所有；缺列或矛盾状态都是未知，不在此清理或补列。
	var checkoutFree bool
	if err := tx.GetContext(ctx, &checkoutFree, tx.Rebind(`SELECT COALESCE(checkout_agent_id, '') = ''
		AND COALESCE(checkout_run_id, '') = '' AND checkout_at IS NULL FROM tasks WHERE id = ?`), i.TaskID); err != nil {
		return err
	}
	if !checkoutFree {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	return nil
}
