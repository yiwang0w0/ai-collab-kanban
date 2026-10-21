package sqlite

import (
	"context"
	"fmt"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// CheckPoolRecoveryExecutionTx 核对实际原生清单与当前回合，不核验或伪造已停止。
func (r *Repository) CheckPoolRecoveryExecutionTx(ctx context.Context, tx *sqlx.Tx, i runsmodels.PoolExecutionIdentity) error {
	if dialect.IsPostgres(r.db.DriverName()) {
		return repoerrors.ErrPoolStorageUnsupported
	}
	currentTurn := turnAuthorityCurrentTurnIDExpr(r.db.DriverName(), "s.id")
	query := fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM task_sessions s
		JOIN task_session_turns t ON t.task_session_id=s.id
		JOIN executors_running er ON er.session_id=s.id AND er.task_id=s.task_id
		WHERE s.id=? AND s.task_id=? AND t.id=? AND t.task_id=? AND s.agent_profile_id=?
		AND COALESCE(s.execution_profile_id,'') IN ('',?) AND COALESCE(t.execution_profile_id,'') IN ('',?)
		AND COALESCE(er.execution_profile_id,'') IN ('',?) AND er.agent_execution_id=?
		AND s.executor_id=? AND er.executor_id=s.executor_id AND er.runtime IN ('','standalone')
		AND t.id=%s AND (SELECT COUNT(*) FROM executors_running scope WHERE scope.session_id=s.id)=1)`, currentTurn)
	var matched bool
	if err := tx.GetContext(ctx, &matched, tx.Rebind(query), i.SessionID, i.TaskID, i.TurnID, i.TaskID,
		i.AgentProfileID, i.ExecutionProfileID, i.ExecutionProfileID, i.ExecutionProfileID, i.ExecutionID, models.ExecutorIDWorktree); err != nil {
		return err
	}
	if !matched {
		return runsmodels.ErrPoolRecoveryConflict
	}
	return nil
}
