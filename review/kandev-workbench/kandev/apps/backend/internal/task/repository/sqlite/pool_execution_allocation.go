package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// CheckPoolExecutionAllocationTx 只排除这次实际分配的会话与回合，其他占用仍阻塞。
func (r *Repository) CheckPoolExecutionAllocationTx(ctx context.Context, tx *sqlx.Tx, release runsmodels.PoolReleaseSnapshot, identity runsmodels.PoolExecutionIdentity) (string, error) {
	if dialect.IsPostgres(r.db.DriverName()) || identity.TaskID != release.TaskID || identity.AgentProfileID != release.AgentProfileID {
		return "", models.ErrPoolExecutionUnavailable
	}
	if err := r.checkPoolDependenciesTx(ctx, tx, identity.TaskID); err != nil {
		return "", err
	}
	if err := r.checkPoolTaskActivityTx(ctx, tx, identity.TaskID, identity.RunID, identity.SessionID, identity.TurnID); err != nil {
		return "", err
	}
	choice, err := r.poolProfileCandidateTx(ctx, tx, release.WorkspaceID, identity.AgentProfileID)
	if err != nil {
		return "", err
	}
	if err := r.loadPoolAllocatedExecutorTx(ctx, tx, identity, &choice); err != nil {
		return "", err
	}
	if err := choice.Validate(); err != nil {
		return "", err
	}
	var state v1.TaskState
	if err := tx.GetContext(ctx, &state, tx.Rebind(`SELECT state FROM tasks WHERE id = ?`), identity.TaskID); err != nil {
		return "", err
	}
	switch state {
	case v1.TaskStateTODO, v1.TaskStateCreated, v1.TaskStateScheduling, v1.TaskStateReview, v1.TaskStateBlocked, v1.TaskStateWaitingForInput:
		return choice.AgentFamily, nil
	default:
		return "", repoerrors.ErrPoolTaskNotAdmitted
	}
}

func (r *Repository) loadPoolAllocatedExecutorTx(ctx context.Context, tx *sqlx.Tx, i runsmodels.PoolExecutionIdentity, choice *models.PoolExecutionCandidate) error {
	err := tx.QueryRowContext(ctx, tx.Rebind(`SELECT e.type, e.status
		FROM task_sessions s JOIN task_session_turns t ON t.task_session_id = s.id
		JOIN executors_running er ON er.session_id = s.id AND er.task_id = s.task_id
		JOIN executors e ON e.id = s.executor_id
		WHERE s.id = ? AND t.id = ? AND s.task_id = ? AND t.task_id = ? AND s.agent_profile_id = ?
		AND COALESCE(s.execution_profile_id, '') IN ('', ?) AND COALESCE(t.execution_profile_id, '') IN ('', ?)
		AND er.agent_execution_id = ? AND er.execution_profile_id = ? AND er.executor_id = s.executor_id AND t.completed_at IS NULL
		AND s.state IN ('CREATED', 'STARTING', 'WAITING_FOR_INPUT') AND e.deleted_at IS NULL`),
		i.SessionID, i.TurnID, i.TaskID, i.TaskID, i.AgentProfileID, i.ExecutionProfileID, i.ExecutionProfileID, i.ExecutionID, i.ExecutionProfileID).Scan(
		&choice.ExecutorType, &choice.ExecutorStatus)
	if err != nil {
		return models.ErrPoolExecutionUnavailable
	}
	return nil
}
