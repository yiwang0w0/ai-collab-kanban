package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// CheckPoolReleaseReadyTx 不清理缺失的依赖；未知前置必须保留为阻塞事实。
func (r *Repository) CheckPoolReleaseReadyTx(ctx context.Context, tx *sqlx.Tx, release runsmodels.PoolReleaseSnapshot) error {
	if dialect.IsPostgres(r.db.DriverName()) {
		return repoerrors.ErrPoolStorageUnsupported
	}
	return r.checkPoolTaskReadyTx(ctx, tx, release.TaskID, release.WorkspaceID, release.AgentProfileID, "")
}

// CheckPoolClaimReadyTx 仅在已验证领取的共享事务内排除当前运行，不排除会话或回合。
func (r *Repository) CheckPoolClaimReadyTx(ctx context.Context, tx *sqlx.Tx, release runsmodels.PoolReleaseSnapshot, runID string) error {
	if dialect.IsPostgres(r.db.DriverName()) || runID == "" {
		return repoerrors.ErrPoolStorageUnsupported
	}
	return r.checkPoolTaskReadyTx(ctx, tx, release.TaskID, release.WorkspaceID, release.AgentProfileID, runID)
}

// CheckPoolRetryReadyTx 仅供已证明停止或已核对原生重试回执的协调器使用，不改主卡状态。
func (r *Repository) CheckPoolRetryReadyTx(ctx context.Context, tx *sqlx.Tx, release runsmodels.PoolReleaseSnapshot, runID string) error {
	if dialect.IsPostgres(r.db.DriverName()) || runID == "" {
		return repoerrors.ErrPoolStorageUnsupported
	}
	if err := r.checkPoolDependenciesTx(ctx, tx, release.TaskID); err != nil {
		return err
	}
	if err := r.checkPoolTaskInactiveTx(ctx, tx, release.TaskID, runID); err != nil {
		return err
	}
	return r.checkPoolExecutionCandidateForRetryTx(ctx, tx, release.TaskID, release.WorkspaceID, release.AgentProfileID, true)
}

func (r *Repository) checkPoolTaskReadyTx(ctx context.Context, tx stepTransitionTx, taskID, workspaceID, profileID, allowedRunID string) error {
	if err := r.checkPoolDependenciesTx(ctx, tx, taskID); err != nil {
		return err
	}
	if err := r.checkPoolTaskInactiveTx(ctx, tx, taskID, allowedRunID); err != nil {
		return err
	}
	return r.checkPoolExecutionCandidateTx(ctx, tx, taskID, workspaceID, profileID)
}

func (r *Repository) checkPoolDependenciesTx(ctx context.Context, tx stepTransitionTx, taskID string) error {
	var blocked bool
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT EXISTS (SELECT 1 FROM task_blockers b
		LEFT JOIN tasks predecessor ON predecessor.id = b.blocker_task_id
		WHERE b.task_id = ? AND (predecessor.id IS NULL OR predecessor.archived_at IS NOT NULL
		OR predecessor.state <> ?))`), taskID, v1.TaskStateCompleted).Scan(&blocked)
	if err != nil {
		return err
	}
	if blocked {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	return nil
}

func (r *Repository) checkPoolTaskInactiveTx(ctx context.Context, tx stepTransitionTx, taskID, allowedRunID string) error {
	return r.checkPoolTaskActivityTx(ctx, tx, taskID, allowedRunID, "", "")
}

func (r *Repository) checkPoolTaskActivityTx(ctx context.Context, tx stepTransitionTx, taskID, allowedRunID, allowedSessionID, allowedTurnID string) error {
	var runID string
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT id FROM runs WHERE status IN ('queued', 'claimed')
		AND idempotency_key LIKE ? AND json_extract(payload, '$.task_id') = ? AND id <> ? ORDER BY requested_at, id LIMIT 1`),
		runsmodels.PoolDispatchKeyPrefix+"%", taskID, allowedRunID).Scan(&runID)
	if err == nil {
		return &runsmodels.PoolTaskBusyError{RunID: runID}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var active bool
	err = tx.QueryRowContext(ctx, r.db.Rebind(`SELECT
		EXISTS (SELECT 1 FROM task_sessions WHERE task_id = ? AND (? = '' OR id <> ?) AND COALESCE(state, '') NOT IN
		  ('CREATED', 'IDLE', 'WAITING_FOR_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'))
		OR EXISTS (SELECT 1 FROM task_session_turns WHERE task_id = ? AND (? = '' OR id <> ?) AND completed_at IS NULL)`),
		taskID, allowedSessionID, allowedSessionID, taskID, allowedTurnID, allowedTurnID).Scan(&active)
	if err != nil {
		return err
	}
	if active {
		return repoerrors.ErrPoolTaskNotAdmitted
	}
	return nil
}
