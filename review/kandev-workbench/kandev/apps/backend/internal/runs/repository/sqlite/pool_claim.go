package sqlite

import (
	"context"
	"strings"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// ResolveCurrentPoolClaim 只读重建当前领取；未知不意味着可以重新派发。
func (r *Repository) ResolveCurrentPoolClaim(ctx context.Context, runID string) (*models.ClaimedRun, error) {
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, ErrPoolReceiptUnknown
	}
	tx, err := r.ro.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := r.GetRunByIDTx(ctx, tx, runID)
	if err != nil {
		return nil, err
	}
	if run.Status != models.RunStatusClaimed || run.IdempotencyKey == nil ||
		!strings.HasPrefix(*run.IdempotencyKey, models.PoolDispatchKeyPrefix) {
		return nil, ErrPoolReceiptConflict
	}
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &models.ClaimedRun{Run: run, ClaimID: claimID}, nil
}

func currentPoolClaimID(ctx context.Context, tx *sqlx.Tx, run *models.Run) (string, error) {
	if run.ClaimedAt == nil {
		return "", ErrPoolReceiptUnknown
	}
	var ids []string
	if err := tx.SelectContext(ctx, &ids, tx.Rebind(`SELECT id FROM office_launch_ledger WHERE run_id = ? AND claimed_at = ? LIMIT 2`), run.ID, *run.ClaimedAt); err != nil {
		return "", err
	}
	if len(ids) != 1 {
		return "", ErrPoolReceiptUnknown
	}
	return ids[0], nil
}
