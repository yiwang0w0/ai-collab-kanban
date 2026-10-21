package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// AppendPoolLaunchAdmissionTx 的同 claim 唯一性由原生写事务保护，不可重放签发。
func (r *Repository) AppendPoolLaunchAdmissionTx(ctx context.Context, tx *sqlx.Tx, request models.PoolClaimStart) (*models.RunEvent, error) {
	run, err := r.lockPoolClaimStartTx(ctx, tx, request)
	if err != nil {
		return nil, err
	}
	var previous []models.RunEvent
	if err := tx.SelectContext(ctx, &previous, tx.Rebind(`SELECT * FROM run_events
		WHERE run_id = ? AND event_type = ? AND json_extract(payload, '$.claim_id') = ? ORDER BY seq LIMIT 2`),
		request.RunID, models.PoolLaunchAdmitted, request.ClaimID); err != nil {
		return nil, err
	}
	if len(previous) > 1 {
		return nil, ErrPoolReceiptUnknown
	}
	if len(previous) == 1 {
		var stored models.PoolClaimStart
		if json.Unmarshal([]byte(previous[0].Payload), &stored) != nil || stored.RunID != request.RunID ||
			stored.ClaimID != request.ClaimID || !stored.Release.MatchesRun(run) {
			return nil, ErrPoolReceiptUnknown
		}
		return nil, models.ErrPoolLaunchAlreadyAdmitted
	}
	if err := checkPoolClaimQueueCauseTx(ctx, tx, run, request); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, request.RunID, models.PoolLaunchAdmitted, string(encoded))
}

func (r *Repository) lockPoolClaimStartTx(ctx context.Context, tx *sqlx.Tx, request models.PoolClaimStart) (*models.Run, error) {
	if dialect.IsPostgres(r.db.DriverName()) || !request.Valid() {
		return nil, models.ErrPoolClaimStartConflict
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET id = id WHERE id = ? AND status = 'claimed'`), request.RunID)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, models.ErrPoolClaimStartConflict
	}
	run, err := r.GetRunByIDTx(ctx, tx, request.RunID)
	if err != nil {
		return nil, err
	}
	if !request.Release.MatchesRun(run) || run.SessionID != "" {
		return nil, models.ErrPoolClaimStartConflict
	}
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	if claimID != request.ClaimID {
		return nil, models.ErrPoolClaimStartConflict
	}
	return run, nil
}
