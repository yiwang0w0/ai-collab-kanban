package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

func (r *Repository) PoolRecoveryRunVersionTx(ctx context.Context, tx *sqlx.Tx, run *models.Run) (string, error) {
	var last int
	if err := tx.GetContext(ctx, &last, tx.Rebind(`SELECT COALESCE(MAX(seq),-1) FROM run_events WHERE run_id=?`), run.ID); err != nil {
		return "", err
	}
	return models.PoolRecoveryRunVersion(run, last), nil
}

// FindPoolRecoveryOperationTx 在有界结果内找原回执；正文不一致由调用者拒绝。
func (r *Repository) FindPoolRecoveryOperationTx(ctx context.Context, tx *sqlx.Tx, runID, operationID string) (*models.RunEvent, error) {
	var events []*models.RunEvent
	err := tx.SelectContext(ctx, &events, tx.Rebind(`SELECT run_id,seq,event_type,level,
		CASE WHEN length(CAST(payload AS BLOB))<=8192 THEN payload ELSE '{}' END AS payload,created_at
		FROM run_events WHERE run_id=? AND event_type IN (?,?,?) AND
		CASE WHEN json_valid(payload) THEN json_extract(payload,'$.command.operation_id') ELSE NULL END=? LIMIT 2`),
		runID, models.PoolRecoveryWithdrawn, models.PoolRecoveryStopRequested, models.PoolRecoveryRequeued, operationID)
	if err != nil {
		return nil, err
	}
	if len(events) > 1 {
		return nil, models.ErrPoolRecoveryConflict
	}
	if len(events) == 0 {
		return nil, nil
	}
	return events[0], nil
}

// CheckPoolWithdrawalTx 只读取未领取、没有执行证据的原生队列前提。
func (r *Repository) CheckPoolWithdrawalTx(ctx context.Context, tx *sqlx.Tx, run *models.Run) error {
	if run.Status != models.RunStatusQueued || run.ClaimedAt != nil || run.SessionID != "" || run.FinishedAt != nil || run.Outcome != nil {
		return models.ErrPoolRecoveryConflict
	}
	var claimed, evidence bool
	if err := tx.GetContext(ctx, &claimed, tx.Rebind(`SELECT EXISTS(SELECT 1 FROM office_launch_ledger WHERE run_id=?)`), run.ID); err != nil {
		return err
	}
	if err := tx.GetContext(ctx, &evidence, tx.Rebind(`SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%')`), run.ID); err != nil {
		return err
	}
	if claimed || evidence {
		return models.ErrPoolRecoveryConflict
	}
	return nil
}

// PoolRecoveryClaimIDTx 只使用唯一原生领取记录，不猜测最近一次执行。
func (r *Repository) PoolRecoveryClaimIDTx(ctx context.Context, tx *sqlx.Tx, run *models.Run) (string, error) {
	return currentPoolClaimID(ctx, tx, run)
}

// WithdrawPoolRunTx 只在调用者已持有原生任务准入、核对版本的事务内写入。
func (r *Repository) WithdrawPoolRunTx(ctx context.Context, tx *sqlx.Tx, run *models.Run, operation models.PoolRecoveryOperation) (*models.RunEvent, error) {
	if err := r.CheckPoolWithdrawalTx(ctx, tx, run); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		return nil, err
	}
	event, err := insertPoolEvent(ctx, tx, run.ID, models.PoolRecoveryWithdrawn, string(encoded))
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET status='cancelled',finished_at=?,cancel_reason='pool_withdrawn'
		WHERE id=? AND status='queued' AND claimed_at IS NULL AND COALESCE(session_id,'')='' AND finished_at IS NULL AND outcome IS NULL`), event.CreatedAt, run.ID)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, models.ErrPoolRecoveryConflict
	}
	return event, nil
}
