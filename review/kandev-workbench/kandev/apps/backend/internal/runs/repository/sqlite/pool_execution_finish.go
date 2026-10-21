package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// FinalizeStoppedPoolRunTx 仅供持有原生资源与任务屏障的服务调用；当前领取和全部持久证据仍在此重查。
func (r *Repository) FinalizeStoppedPoolRunTx(ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity) (*models.RunEvent, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	if err := r.LockPoolTaskTx(ctx, tx, identity.TaskID); err != nil {
		return nil, err
	}
	run, stopped, err := r.poolFinishEvidenceTx(ctx, tx, identity)
	if err != nil {
		return nil, err
	}
	receipt := models.PoolExecutionFinishReceipt{PoolExecutionIdentity: identity, StoppedSeq: stopped.Seq}
	previous, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolExecutionFinished)
	if err != nil {
		return nil, err
	}
	if len(previous) == 1 {
		return replayPoolExecutionFinish(run, previous[0], receipt)
	}
	if run.Status != models.RunStatusClaimed || run.FinishedAt != nil || run.Outcome != nil {
		return nil, ErrPoolReceiptConflict
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	event, err := insertPoolEvent(ctx, tx, identity.RunID, models.PoolExecutionFinished, string(encoded))
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET status='finished',outcome=?,finished_at=?
		WHERE id=? AND status='claimed' AND claimed_at=? AND session_id=?`),
		models.PoolOutcomeExecutionStopped, event.CreatedAt, identity.RunID, *run.ClaimedAt, identity.SessionID)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, ErrPoolReceiptConflict
	}
	return event, nil
}

func replayPoolExecutionFinish(run *models.Run, event models.RunEvent, expected models.PoolExecutionFinishReceipt) (*models.RunEvent, error) {
	var stored models.PoolExecutionFinishReceipt
	if json.Unmarshal([]byte(event.Payload), &stored) != nil || stored != expected ||
		run.Status != models.RunStatusFinished || run.FinishedAt == nil || !run.FinishedAt.Equal(event.CreatedAt) ||
		run.Outcome == nil || *run.Outcome != models.PoolOutcomeExecutionStopped {
		return nil, ErrPoolReceiptConflict
	}
	return &event, nil
}
